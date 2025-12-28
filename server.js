const cluster = require('cluster');
const { ethers } = require('ethers');
const WebSocket = require('ws');
const axios = require('axios');
require('dotenv').config();

// --- THEME ENGINE ---
const TXT = {
    reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
    green: "\x1b[32m", cyan: "\x1b[36m", yellow: "\x1b[33m", 
    magenta: "\x1b[35m", blue: "\x1b[34m", red: "\x1b[31m",
    gold: "\x1b[38;5;220m", silver: "\x1b[38;5;250m"
};

// --- CONFIGURATION ---
const CONFIG = {
    // 🔒 PROFIT DESTINATION (Your Address)
    BENEFICIARY: "0x4B8251e7c80F910305bb81547e301DcB8A596918",
    
    // ⚙️ NETWORK & CONTRACTS
    CHAIN_ID: 8453, // Base Network
    CONTRACT_ADDR: "0x83EF5c401fAa5B9674BAfAcFb089b30bAc67C9A0", // Arbitrage Contract
    MERKLE_RPC: "https://base.merkle.io", // Private Transaction Relay
    
    // 🔮 ORACLES
    GAS_ORACLE: "0x420000000000000000000000000000000000000F",
    CHAINLINK_FEED: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
    
    // 🏦 ASSETS
    TOKENS: { 
        WETH: "0x4200000000000000000000000000000000000006", 
        DEGEN: "0x4edbc9ba171790664872997239bc7a3f3a633190"
    },

    // ⚡ STRATEGY SETTINGS
    LOAN_AMOUNT: ethers.parseEther("600"), // Flash Loan Target
    GAS_LIMIT: 900000,
    PRIORITY_BRIBE: 15n, // 15% Miner Tip
    WHALE_THRESHOLD: ethers.parseEther("1.0"), // Trigger on >1 ETH txs
    MIN_NET_PROFIT: "0.02" // Minimum profit to execute
};

// MULTI-RPC FAILOVER POOL
const RPC_POOL = [
    process.env.QUICKNODE_HTTP,
    "https://mainnet.base.org",
    "https://base.llamarpc.com",
    "https://1rpc.io/base"
].filter(url => url);

// Use Public WS for scanning (Cost efficiency)
const WSS_URL = "wss://base-rpc.publicnode.com";

// --- MASTER THREAD ---
if (cluster.isPrimary) {
    console.clear();
    console.log(`${TXT.bold}${TXT.gold}╔═══════════════════════════════════════════════╗${TXT.reset}`);
    console.log(`${TXT.bold}${TXT.gold}║    🔱 APEX v38.17.1 | MEV ARBITRAGE ENGINE    ║${TXT.reset}`);
    console.log(`${TXT.bold}${TXT.gold}╚═══════════════════════════════════════════════╝${TXT.reset}\n`);
    
    const worker = cluster.fork();
    worker.on('exit', () => {
        console.log(`${TXT.red}⚠️ Worker died. Respawning...${TXT.reset}`);
        cluster.fork();
    });
} else {
    runWorker();
}

// --- WORKER THREAD ---
async function runWorker() {
    // 1. SETUP FAILOVER PROVIDER
    const rawKey = process.env.TREASURY_PRIVATE_KEY || process.env.PRIVATE_KEY;
    if (!rawKey) { console.error(`${TXT.red}❌ Key Missing in .env${TXT.reset}`); process.exit(1); }
    
    const network = ethers.Network.from(CONFIG.CHAIN_ID);
    const configs = RPC_POOL.map((url, i) => ({
        provider: new ethers.JsonRpcProvider(url, network, { staticNetwork: true }),
        priority: i + 1,
        stallTimeout: 2000
    }));

    const provider = new ethers.FallbackProvider(configs, network, { quorum: 1 });
    const signer = new ethers.Wallet(rawKey.trim(), provider);
    
    // Contracts
    const flashContract = new ethers.Contract(CONFIG.CONTRACT_ADDR, [
        "function executeFlashArbitrage(address tokenA, address tokenOut, uint256 amount) external returns (uint256)"
    ], signer);
    
    const gasOracle = new ethers.Contract(CONFIG.GAS_ORACLE, ["function getL1Fee(bytes) view returns (uint256)"], provider);
    const priceFeed = new ethers.Contract(CONFIG.CHAINLINK_FEED, ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"], provider);

    // State
    let nextNonce = await provider.getTransactionCount(signer.address);
    let currentEthPrice = 0;
    let ws = null;
    let scanCount = 0;
    const seenHashes = new Set();

    process.stdout.write(`${TXT.cyan}[INIT] Nonce: ${nextNonce} | RPCs: ${RPC_POOL.length} | MEV Mode: ACTIVE${TXT.reset}\n`);

    // 2. LIVE PRICE TRACKER
    setInterval(async () => {
        try {
            const [, price] = await priceFeed.latestRoundData();
            currentEthPrice = Number(price) / 1e8;
        } catch (e) {}
    }, 15000);

    // 3. CONNECTION LOGIC (WebSocket)
    function connect() {
        if (ws) ws.terminate();
        ws = new WebSocket(WSS_URL);

        ws.on('open', () => {
            console.log(`${TXT.green}📡 MEMPOOL SCANNER CONNECTED${TXT.reset}`);
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newPendingTransactions"] }));
        });

        ws.on('message', async (data) => {
            const parsed = JSON.parse(data);
            const txHash = parsed.params?.result;
            if (txHash && !seenHashes.has(txHash)) {
                seenHashes.add(txHash);
                scanCount++;
                processTransaction(txHash); // Fire and forget (Async)
            }
        });

        ws.on('close', () => setTimeout(connect, 2000));
        ws.on('error', () => ws.terminate());
    }

    // 4. MEV PROCESSOR
    async function processTransaction(txHash) {
        try {
            // A. AGGRESSIVE FETCH (Inspect pending TX)
            const tx = await provider.getTransaction(txHash).catch(() => null);
            if (!tx || !tx.value || tx.value < CONFIG.WHALE_THRESHOLD) return;

            console.log(`\n${TXT.magenta}🎯 WHALE DETECTED: ${ethers.formatEther(tx.value)} ETH${TXT.reset}`);

            // B. SIMULATION & FEE CHECK
            // We simulate the exact trade: WETH -> DEGEN
            const amountWei = CONFIG.LOAN_AMOUNT;
            
            // Encode Data for L1 Fee Calc
            const txData = flashContract.interface.encodeFunctionData("executeFlashArbitrage", [
                CONFIG.TOKENS.WETH, CONFIG.TOKENS.DEGEN, amountWei
            ]);

            // Parallel Pre-Flight Check (Sim + L1 Fee + Gas)
            const [profit, l1Fee, feeData] = await Promise.all([
                flashContract.executeFlashArbitrage.staticCall(CONFIG.TOKENS.WETH, CONFIG.TOKENS.DEGEN, amountWei).catch(() => 0n),
                gasOracle.getL1Fee(txData).catch(() => 0n),
                provider.getFeeData()
            ]);

            if (BigInt(profit) === 0n) return; // Not profitable

            // C. MAXIMIZED COST CALCULATION
            const aggressivePriority = (feeData.maxPriorityFeePerGas * (100n + CONFIG.PRIORITY_BRIBE)) / 100n;
            const l2Cost = BigInt(CONFIG.GAS_LIMIT) * feeData.maxFeePerGas;
            const totalCost = l2Cost + l1Fee;
            const netProfit = BigInt(profit) - totalCost;

            // D. EXECUTION TRIGGER
            if (netProfit > ethers.parseEther(CONFIG.MIN_NET_PROFIT)) {
                const profitUSD = parseFloat(ethers.formatEther(netProfit)) * currentEthPrice;
                console.log(`${TXT.gold}💰 OPPORTUNITY: ${ethers.formatEther(netProfit)} ETH (~$${profitUSD.toFixed(2)})${TXT.reset}`);
                
                // Sign locally
                const signedTx = await signer.signTransaction({
                    to: CONFIG.CONTRACT_ADDR,
                    data: txData,
                    gasLimit: CONFIG.GAS_LIMIT,
                    maxPriorityFeePerGas: aggressivePriority,
                    maxFeePerGas: feeData.maxFeePerGas,
                    nonce: nextNonce++,
                    type: 2,
                    chainId: CONFIG.CHAIN_ID
                });

                console.log(`${TXT.yellow}⚡ SUBMITTING TO PRIVATE RELAY...${TXT.reset}`);
                
                // Send to Private Relay (Bypass Public Mempool)
                const res = await axios.post(CONFIG.MERKLE_RPC, { 
                    jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [signedTx] 
                });

                if (res.data.result) {
                    console.log(`${TXT.green}🚀 MEV STRIKE SUCCESS: ${res.data.result}${TXT.reset}`);
                    console.log(`${TXT.bold}💸 Profit directed to: ${CONFIG.BENEFICIARY}${TXT.reset}`);
                } else {
                    console.log(`${TXT.red}❌ REVERTED: ${JSON.stringify(res.data)}${TXT.reset}`);
                }
            }

        } catch (e) {
            // Nonce management for rapid firing
            if (e.message.includes("nonce")) nextNonce = await provider.getTransactionCount(signer.address);
        }
    }

    // Start Scanner
    setInterval(() => {
        process.stdout.write(`\r${TXT.dim}[SCANNING]${TXT.reset} ${TXT.cyan}Active${TXT.reset} | ${TXT.silver}Tx Scanned: ${scanCount}${TXT.reset} | ${TXT.gold}ETH: $${currentEthPrice.toFixed(2)}${TXT.reset}   `);
        seenHashes.clear();
    }, 5000);
    
    connect();
}
