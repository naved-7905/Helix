var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import { Telegraf, Markup, session } from "telegraf";
import { Keypair, Connection, LAMPORTS_PER_SOL, PublicKey, } from "@solana/web3.js";
import Wallet from "./database";
import MeteoraService from "./services/meteora";
import { SUPPORTED_TOKENS } from "./config/meteora";
import TokenService from "./services/token";
import MeteoraPositionService from "./services/meteora-position-service";
import dotenv from 'dotenv';
import OpenAI from "openai";
import cron from 'node-cron';
import axios from "axios";
import express from 'express';
dotenv.config();
// Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});
// Global storage for user pool addresses, position mappings, and rebalancing processes
const userPoolAddresses = new Map();
const positionMappings = new Map();
const rebalancingProcesses = new Map();
// Ensure TELEGRAM_BOT_TOKEN exists
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set in environment variables");
}
const bot = new Telegraf(token);
bot.use(session());
const connection = new Connection(process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : 'https://api.mainnet-beta.solana.com');
const meteora = new MeteoraService(connection);
const tokenService = new TokenService();
const positionService = new MeteoraPositionService(connection);
// Configuration for rebalancing
const REBALANCE_THRESHOLD = 0.001; // 0.05% price change threshold
const RANGE_INTERVAL = 20; // Number of bins on each side of active bin
const HISTORY_LENGTH = 20; // Keep track of last N price points
// Token Program ID for SPL tokens
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
// Mint addresses (adjust as per your pool)
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // Mainnet USDC mint
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112"); // Wrapped SOL mint
// Current token prices in USD
const SOL_PRICE_USD = 138; // Updated SOL price based on your context ($1.38 for 0.01 SOL)
const USDC_PRICE_USD = 1; // USDC typically pegged at $1
// Helper function to fetch pool token balances
const fetchPoolTokenBalances = (poolAddress) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const poolPublicKey = new PublicKey(poolAddress);
        const tokenAccounts = yield connection.getParsedTokenAccountsByOwner(poolPublicKey, {
            programId: TOKEN_PROGRAM_ID,
        });
        let usdcBalance = 0;
        let solBalance = 0;
        tokenAccounts.value.forEach((tokenAccount) => {
            const accountData = tokenAccount.account.data.parsed.info;
            const mintAddress = new PublicKey(accountData.mint);
            const tokenBalance = parseFloat(accountData.tokenAmount.uiAmountString); // Already decimal-adjusted
            if (mintAddress.equals(USDC_MINT)) {
                usdcBalance = tokenBalance;
            }
            else if (mintAddress.equals(SOL_MINT)) {
                solBalance = tokenBalance;
            }
        });
        return { usdcBalance, solBalance };
    }
    catch (error) {
        console.error("Error fetching pool token balances:", error);
        return { usdcBalance: 0, solBalance: 0 }; // Fallback to 0 on error
    }
});
// Rebalancing logic per user
function startRebalancing(userId, poolAddress, userKeypair, initialPositionId, amount) {
    return __awaiter(this, void 0, void 0, function* () {
        let lastPositionPrice = 0;
        let priceHistory = [];
        let positionPublicKey = new PublicKey(initialPositionId);
        const initialize = () => __awaiter(this, void 0, void 0, function* () {
            try {
                const dlmmPool = yield positionService.createDLMMInstance(poolAddress);
                const activeBin = yield dlmmPool.getActiveBin();
                lastPositionPrice = Number(dlmmPool.fromPricePerLamport(Number(activeBin.price)));
                console.log(`[${userId}] Initial price: ${lastPositionPrice}`);
                priceHistory.push({ timestamp: Date.now(), price: lastPositionPrice });
            }
            catch (error) {
                console.error(`[${userId}] Error during initialization:`, error);
            }
        });
        const checkAndRebalance = () => __awaiter(this, void 0, void 0, function* () {
            try {
                const dlmmPool = yield positionService.createDLMMInstance(poolAddress);
                const activeBin = yield dlmmPool.getActiveBin();
                const currentPrice = Number(dlmmPool.fromPricePerLamport(Number(activeBin.price)));
                priceHistory.push({ timestamp: Date.now(), price: currentPrice });
                if (priceHistory.length > HISTORY_LENGTH)
                    priceHistory.shift();
                const priceChangePercent = (currentPrice - lastPositionPrice) / lastPositionPrice;
                console.log(`[${userId}] Current price: ${currentPrice}, Change: ${(priceChangePercent * 100).toFixed(2)}%`);
                if (Math.abs(priceChangePercent) >= REBALANCE_THRESHOLD) {
                    const direction = priceChangePercent > 0 ? "up" : "down";
                    console.log(`[${userId}] Price moved ${direction} by ${(priceChangePercent * 100).toFixed(2)}%. Consulting GPT...`);
                    const rebalanceNeeded = yield consultGPT(userId, currentPrice, priceChangePercent, priceHistory);
                    if (rebalanceNeeded) {
                        yield rebalancePosition(userId, dlmmPool, currentPrice, direction, userKeypair);
                        lastPositionPrice = currentPrice;
                    }
                }
            }
            catch (error) {
                console.error(`[${userId}] Error during rebalance check:`, error);
            }
        });
        const consultGPT = (userId, currentPrice, priceChangePercent, priceHistory) => __awaiter(this, void 0, void 0, function* () {
            try {
                const historyData = priceHistory.map(point => `${new Date(point.timestamp).toISOString()}: $${point.price.toFixed(6)}`).join('\n');
                const response = yield openai.chat.completions.create({
                    model: "gpt-4-turbo-preview",
                    messages: [
                        { role: "system", content: "You are a DeFi liquidity position manager specializing in Meteora DLMM pools." },
                        {
                            role: "user",
                            content: `
Current price: $${currentPrice.toFixed(6)}
Price change: ${(priceChangePercent * 100).toFixed(2)}%
Rebalance threshold: ${REBALANCE_THRESHOLD * 100}%

Recent price history:
${historyData}

If the absolute price change exceeds ${REBALANCE_THRESHOLD * 100}% (i.e., greater than 0.1% or less than -0.1%), respond "YES" followed by a brief explanation confirming the threshold was exceeded.
Otherwise, respond "NO" followed by a brief explanation confirming the threshold was not exceeded.
Do not consider trend, volatility, or momentum beyond the threshold check.
`
                        }
                    ]
                });
                const gptResponse = response.choices[0].message.content || "";
                console.log(`[${userId}] GPT Response: ${gptResponse}`);
                const shouldRebalance = gptResponse.trim().toUpperCase().startsWith("YES");
                // Enforce threshold check as a fallback in case GPT misinterprets
                const absoluteChange = Math.abs(priceChangePercent);
                if (absoluteChange >= REBALANCE_THRESHOLD && !shouldRebalance) {
                    console.log(`[${userId}] GPT said NO but threshold exceeded (${(absoluteChange * 100).toFixed(2)}% >= ${REBALANCE_THRESHOLD * 100}%). Forcing rebalance.`);
                    return true;
                }
                return shouldRebalance;
            }
            catch (error) {
                console.error(`[${userId}] Error consulting GPT:`, error);
                // Fallback to threshold check if GPT fails
                return Math.abs(priceChangePercent) >= REBALANCE_THRESHOLD;
            }
        });
        const rebalancePosition = (userId, dlmmPool, currentPrice, direction, userKeypair) => __awaiter(this, void 0, void 0, function* () {
            try {
                if (!positionPublicKey) {
                    console.log(`[${userId}] No position found. Creating new position.`);
                    const position = yield positionService.createPosition(dlmmPool, userKeypair, amount);
                    positionPublicKey = new PublicKey(position.positionId);
                    const { usdcBalance, solBalance } = yield fetchPoolTokenBalances(poolAddress);
                    const earningUrl = `https://dlmm-api.meteora.ag/wallet/${userKeypair.publicKey.toString()}/${poolAddress}/earning`;
                    const earningResponse = yield axios.get(earningUrl);
                    const earningData = earningResponse.data[0] || {};
                    console.log(`[${userId}] After new position: Pool SOL: ${solBalance}, Pool USDC: ${usdcBalance}, Fees USD: ${earningData.total_fee_usd_claimed}`);
                    return;
                }
                console.log(`[${userId}] Rebalancing position ${positionPublicKey.toBase58()}`);
                const txSignatures = yield positionService.removePositionLiquidity(dlmmPool, userKeypair, positionPublicKey.toBase58());
                console.log(`[${userId}] Removed liquidity with txs: ${txSignatures}`);
                const position = yield positionService.createPosition(dlmmPool, userKeypair, amount);
                positionPublicKey = new PublicKey(position.positionId);
                console.log(`[${userId}] New position created: ${positionPublicKey.toBase58()}, tx: ${position.transactionHash}`);
                const { usdcBalance, solBalance } = yield fetchPoolTokenBalances(poolAddress);
                const earningUrl = `https://dlmm-api.meteora.ag/wallet/${userKeypair.publicKey.toString()}/${poolAddress}/earning`;
                const earningResponse = yield axios.get(earningUrl);
                const earningData = earningResponse.data[0] || {};
                console.log(`[${userId}] After rebalance: Pool SOL: ${solBalance}, Pool USDC: ${usdcBalance}, Fees USD: ${earningData.total_fee_usd_claimed}`);
            }
            catch (error) {
                console.error(`[${userId}] Error during rebalancing:`, error);
                if (error instanceof Error && error.message.includes("No liquidity to remove")) {
                    const position = yield positionService.createPosition(dlmmPool, userKeypair, amount);
                    positionPublicKey = new PublicKey(position.positionId);
                    console.log(`[${userId}] Created new position after no liquidity error: ${positionPublicKey.toBase58()}`);
                    const { usdcBalance, solBalance } = yield fetchPoolTokenBalances(poolAddress);
                    const earningUrl = `https://dlmm-api.meteora.ag/wallet/${userKeypair.publicKey.toString()}/${poolAddress}/earning`;
                    const earningResponse = yield axios.get(earningUrl);
                    const earningData = earningResponse.data[0] || {};
                    console.log(`[${userId}] After new position (no liquidity): Pool SOL: ${solBalance}, Pool USDC: ${usdcBalance}, Fees USD: ${earningData.total_fee_usd_claimed}`);
                }
            }
        });
        yield initialize();
        const cronJob = cron.schedule('*/30 * * * * *', checkAndRebalance);
        rebalancingProcesses.set(userId, { lastPositionPrice, priceHistory, positionPublicKey, cronJob });
    });
}
const getMainKeyboard = () => {
    return Markup.keyboard([
        ["📈 Open Position", "📊 Portfolio"],
        ["👛 Wallet", "⚙️ Settings"],
        ["❔ Help", "🔄 Refresh"],
    ]).resize();
};
bot.command("start", (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const userId = ctx.from.id.toString();
        let wallet = yield Wallet.findOne({ userId });
        if (!wallet) {
            const keypair = Keypair.generate();
            wallet = new Wallet({
                userId,
                publicKey: keypair.publicKey.toBase58(),
                secretKey: Buffer.from(keypair.secretKey).toString("hex"),
                firstStart: false,
            });
            yield wallet.save();
            yield ctx.reply(`Welcome to Cleopetra: the easiest way to LP on Solana DEXes!\n\n` +
                `👛 Your new wallet has been created:\n${wallet.publicKey}\n\n` +
                `Get started by depositing SOL and selecting options below:`, getMainKeyboard());
        }
        else {
            yield ctx.reply("Welcome back to Cleopetra!", getMainKeyboard());
        }
    }
    catch (error) {
        console.error("Start command error:", error);
        ctx.reply("An error occurred. Please try again.");
    }
}));
const openPositionHandler = (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const wallet = yield Wallet.findOne({ userId: ctx.from.id.toString() });
        if (!wallet) {
            return ctx.reply("Wallet not found. Please restart the bot.");
        }
        const tokens = Object.keys(SUPPORTED_TOKENS).filter((t) => t !== "SOL");
        const buttons = tokens.map((token) => [
            Markup.button.callback(`${token}`, `select_token_${token}`),
        ]);
        buttons.push([Markup.button.callback("Back to Main Menu", "back_to_main")]);
        yield ctx.reply("Choose a token from below whitelist to create a position:", Markup.inlineKeyboard(buttons));
    }
    catch (error) {
        ctx.reply("Error loading tokens. Please try again.");
    }
});
const walletHandler = (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const wallet = yield Wallet.findOne({ userId: ctx.from.id.toString() });
        if (!wallet) {
            return ctx.reply("Wallet not found. Please restart the bot.");
        }
        const balance = yield connection.getBalance(new PublicKey(wallet.publicKey));
        const solBalance = balance / LAMPORTS_PER_SOL;
        const usdValue = (solBalance * SOL_PRICE_USD).toFixed(2); // Updated with current SOL price, 2 decimal places
        const buttons = Markup.inlineKeyboard([
            [
                Markup.button.url("View on Solscan", `https://solscan.io/account/${wallet.publicKey}`),
                Markup.button.callback("View Private Key", "view_wallet_info"),
            ],
            [Markup.button.callback("Transaction History", "tx_history"), Markup.button.callback("Refresh Balance", "refresh_balance")],
            [Markup.button.callback("Send SOL", "send_sol")],
            [Markup.button.callback("Back to Main Menu", "back_to_main")],
        ]);
        yield ctx.reply(`👛 Wallet Details:\n\nBalance: ${solBalance.toFixed(6)} SOL ($${usdValue})\nAddress: ${wallet.publicKey}`, buttons);
    }
    catch (error) {
        ctx.reply("Error fetching wallet details.");
    }
});
bot.action("view_wallet_info", (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const wallet = yield Wallet.findOne({ userId: ctx.from.id.toString() });
        if (!wallet) {
            return ctx.reply("Wallet not found. Please restart the bot.");
        }
        const message = `⚠️ SECURITY WARNING ⚠️
Never share your private key with anyone!
Anyone with this key has full control over your wallet.
Your Private Key:
${wallet.secretKey}
Keep this information safe and secure!`;
        yield ctx.reply(message, Markup.inlineKeyboard([
            [Markup.button.callback("Back to Wallet", "wallet")],
            [Markup.button.callback("Main Menu", "back_to_main")],
        ]));
        yield ctx.deleteMessage();
    }
    catch (error) {
        console.error("Error fetching private key:", error);
        yield ctx.reply("Error fetching private key information.", Markup.inlineKeyboard([
            [Markup.button.callback("Back to Wallet", "wallet")],
            [Markup.button.callback("Main Menu", "back_to_main")],
        ]));
    }
}));
const settingsHandler = (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    const buttons = Markup.inlineKeyboard([
        [Markup.button.callback("Auto-Rebalancing Settings", "rebalance_settings")],
        [Markup.button.callback("Network Settings", "network_settings")],
        [Markup.button.callback("Back to Main Menu", "back_to_main")],
    ]);
    yield ctx.reply("⚙️ Settings Menu:", buttons);
});
const helpHandler = (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    const helpMessage = `Welcome to Cleopetra Bot! 🚀
Available Commands:
/start - Return to main menu
/open_position - Create new LP position
/portfolio - View your positions
/wallet - Access wallet features
/settings - Configure settings
/help - Show this help menu
Quick Guide:
Start by depositing SOL to your wallet
Select a token to create a position
Choose your strategy and confirm
Monitor your positions in Portfolio
Need assistance?
Contact support or visit our documentation.`;
    yield ctx.replyWithMarkdown(helpMessage, Markup.inlineKeyboard([[Markup.button.callback("Back to Main Menu", "back_to_main")]]));
});
const refreshHandler = (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const wallet = yield Wallet.findOne({ userId: ctx.from.id.toString() });
        if (!wallet) {
            return ctx.reply("Wallet not found. Please restart the bot.");
        }
        const balance = yield connection.getBalance(new PublicKey(wallet.publicKey));
        const solBalance = balance / LAMPORTS_PER_SOL;
        const usdValue = (solBalance * SOL_PRICE_USD).toFixed(2); // Updated with current SOL price, 2 decimal places
        yield ctx.reply(`🔄 Updated Balance:\n\n${solBalance.toFixed(6)} SOL ($${usdValue})\n\nLast updated: ${new Date().toLocaleTimeString()}`, Markup.inlineKeyboard([[Markup.button.callback("Back to Main Menu", "back_to_main")]]));
    }
    catch (error) {
        ctx.reply("Error refreshing data.");
    }
});
const sendSolHandler = (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    if (!ctx.session)
        ctx.session = {};
    ctx.session.awaitingSendSol = true;
    yield ctx.reply("💸 Send SOL\n\nPlease enter the recipient address and amount in this format:\n" +
        "[address] [amount]\n\n" +
        "Example: 5Pf8...xYZ 0.1", Markup.inlineKeyboard([[Markup.button.callback("Cancel", "back_to_main")]]));
});
bot.command("open_position", openPositionHandler);
bot.command("wallet", walletHandler);
bot.command("settings", settingsHandler);
bot.command("help", helpHandler);
bot.command("refresh", refreshHandler);
bot.hears("📈 Open Position", openPositionHandler);
bot.hears("👛 Wallet", walletHandler);
bot.hears("⚙️ Settings", settingsHandler);
bot.hears("❔ Help", helpHandler);
bot.hears("🔄 Refresh", refreshHandler);
bot.action("back_to_main", (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    if (ctx.session) {
        ctx.session.awaitingPrivateKey = false;
        ctx.session.awaitingSendSol = false;
        ctx.session.awaitingPositionAmount = false;
    }
    yield ctx.deleteMessage();
    yield ctx.reply("Main Menu:", getMainKeyboard());
}));
bot.action(/select_token_(.+)/, (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const token = ctx.match[1];
        const wallet = yield Wallet.findOne({ userId: ctx.from.id.toString() });
        if (!wallet) {
            return ctx.reply("Wallet not found. Please restart the bot.");
        }
        const balance = yield connection.getBalance(new PublicKey(wallet.publicKey));
        const solBalance = balance / LAMPORTS_PER_SOL;
        const REQUIRED_POSITION_SOL = 0.056565200;
        const REQUIRED_TX_FEE_SOL = 0.05;
        const TOTAL_REQUIRED_SOL = REQUIRED_POSITION_SOL + REQUIRED_TX_FEE_SOL;
        if (solBalance < TOTAL_REQUIRED_SOL) {
            const additionalSolNeeded = (TOTAL_REQUIRED_SOL - solBalance).toFixed(9);
            return ctx.reply(`❌ Insufficient SOL balance!\n\n` +
                `Required SOL:\n` +
                `• ${REQUIRED_POSITION_SOL} SOL for position\n` +
                `• ${REQUIRED_TX_FEE_SOL} SOL for transaction fees\n` +
                `Total required: ${TOTAL_REQUIRED_SOL} SOL\n\n` +
                `Your balance: ${solBalance.toFixed(9)} SOL\n` +
                `You need ${additionalSolNeeded} more SOL\n\n` +
                `Please deposit more SOL to continue.`, Markup.inlineKeyboard([
                [Markup.button.callback("👛 Check Wallet", "wallet")],
                [Markup.button.callback("🏠 Back to Main", "back_to_main")]
            ]));
        }
        const info = yield tokenService.getTokenInfo("usd-coin");
        const tokenBalance = yield tokenService.getTokenBalance(wallet.publicKey, info.solanaAddress);
        const message = `💰 Balance Check Passed!\n\n` +
            `SOL Balance: ${solBalance.toFixed(9)} SOL ($${(solBalance * SOL_PRICE_USD).toFixed(2)})\n` +
            `Token Info:\n` +
            `Price: ${info.price}\n` +
            `Mcap: ${info.marketCap}\n` +
            `Volume Stats:\n` +
            `• 1h: ${info.volumeStats["1h"]}\n` +
            `• 24h: ${info.volumeStats["24h"]}\n` +
            `• 7d: ${info.volumeStats["7d"]}`;
        const buttons = [
            [Markup.button.callback("✅ Create Position", `confirm_token_${token}`)],
            [Markup.button.callback("🔄 Refresh", `refresh_token_${token}`)],
            [Markup.button.callback("❌ Close", "back_to_main")]
        ];
        yield ctx.reply(message, Markup.inlineKeyboard(buttons));
    }
    catch (error) {
        console.error("Error in token selection:", error);
        ctx.reply("Error fetching token details. Please try again.");
    }
}));
bot.action(/confirm_token_(.+)/, (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const token = ctx.match[1];
        const poolInfo = yield meteora.getOptimalPool(token);
        if (!ctx.session)
            ctx.session = {};
        ctx.session.poolInfo = poolInfo;
        ctx.session.selectedToken = token;
        ctx.session.awaitingPositionAmount = true;
        const message = [
            `🎯 Optimal Pool Detected`,
            `Pool: ${poolInfo["Pool"]}`,
            `Address: ${poolInfo["Address"]}`,
            `Bin Step: ${poolInfo["Bin Step"]}`,
            `Base Fee: ${poolInfo["Base Fee"]}`,
            `24h Fee/TVL Ratio: ${poolInfo["24h Fee/TVL Ratio"]}`,
            `\n⚠️ Important Requirements:`,
            `• Minimum SOL needed: 0.056565200 SOL`,
            `• Transaction fees: ~0.05 SOL`,
            `\nℹ️ Please enter the amount of ${token} you want to provide:`,
            `(Example: For 5 ${token}, just type "5")`
        ].join("\n");
        yield ctx.reply(message, Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "back_to_main")]]));
    }
    catch (error) {
        console.error("Error calculating optimal pool:", error);
        ctx.reply("Error calculating optimal pool. Please try again.");
    }
}));
bot.action(/create_position_(.+)_(.+)_(.+)/, (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const [token, amountStr, autoRebalance] = [
            ctx.match[1],
            parseFloat(ctx.match[2]),
            ctx.match[3] === "true"
        ];
        const userId = ctx.from.id.toString();
        console.log("amountStr", amountStr);
        const wallet = yield Wallet.findOne({ userId });
        if (!wallet) {
            return ctx.reply("Wallet not found. Please restart the bot.");
        }
        if (!((_a = ctx.session) === null || _a === void 0 ? void 0 : _a.poolInfo)) {
            return ctx.reply("Pool information not found. Please try selecting a pool again.");
        }
        const poolInfo = ctx.session.poolInfo;
        const loadingMsg = yield ctx.reply("⏳ Initializing DLMM pool...");
        try {
            const dlmmPool = yield positionService.createDLMMInstance(poolInfo.Address);
            yield ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, "⏳ DLMM pool initialized. Creating position...");
            const userKeypair = Keypair.fromSecretKey(Uint8Array.from(Buffer.from(wallet.secretKey, "hex")));
            const position = yield positionService.createPosition(dlmmPool, userKeypair, amountStr);
            // Store the pool address and rebalancing state in the Wallet document
            wallet.poolAddress = poolInfo.Address;
            wallet.autoRebalance = autoRebalance;
            wallet.positionAmount = amountStr;
            yield wallet.save();
            console.log(`Stored pool address ${poolInfo.Address} and amount ${amountStr} for user ${userId} in database`);
            // Store position for portfolio
            positionMappings.set(`${userId}_0`, { poolAddress: poolInfo.Address, positionAddress: position.positionId });
            // Fetch pool balances after position creation
            const { usdcBalance, solBalance } = yield fetchPoolTokenBalances(poolInfo.Address);
            const earningUrl = `https://dlmm-api.meteora.ag/wallet/${wallet.publicKey}/${poolInfo.Address}/earning`;
            const earningResponse = yield axios.get(earningUrl);
            const earningData = earningResponse.data[0] || {};
            console.log(`[${userId}] After position creation: Pool SOL: ${solBalance}, Pool USDC: ${usdcBalance}, Fees USD: ${earningData.total_fee_usd_claimed}`);
            if (loadingMsg && ctx.chat) {
                yield ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => { });
            }
            const usdcAmount = Number(position.positionDetails.amounts.x) / Math.pow(10, 6);
            const solAmount = Number(position.positionDetails.amounts.y) / Math.pow(10, 9);
            const successMessage = [
                "✅ Position Created Successfully!",
                "",
                "📊 Position Details:",
                `Pool: ${poolInfo.Pool}`,
                `Position ID: ${position.positionId}`,
                `Amount X: ${usdcAmount.toFixed(6)} ${token}`,
                `Amount Y: ${solAmount.toFixed(9)} SOL`,
                `Active Bin: ${position.positionDetails.activeBin.binId}`,
                `Current Price: $${Number(position.positionDetails.activeBin.pricePerToken).toFixed(4)}`,
                `Bin Range: ${position.positionDetails.binRange.minBinId} to ${position.positionDetails.binRange.maxBinId}`,
                `Auto-rebalance: ${autoRebalance ? "✅" : "❌"}`,
                "",
                "🔍 Transaction Details:",
                `Hash: ${position.transactionHash}`,
            ].join("\n");
            yield ctx.reply(successMessage, Markup.inlineKeyboard([
                [Markup.button.url("🔎 View Transaction", `https://solscan.io/tx/${position.transactionHash}`)],
                [Markup.button.callback("📊 View Portfolio", "portfolio")],
                [Markup.button.callback("🏠 Back to Main", "back_to_main")],
            ]));
            // Start rebalancing if enabled
            if (autoRebalance) {
                console.log(`Starting rebalancing for user ${userId}`);
                startRebalancing(userId, poolInfo.Address, userKeypair, position.positionId, amountStr);
            }
        }
        catch (error) {
            console.error("DLMM creation error:", error);
            if (loadingMsg && ctx.chat) {
                yield ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => { });
            }
            yield ctx.reply("❌ Error creating position. Please check your balance and try again.", Markup.inlineKeyboard([
                [Markup.button.callback("🔄 Try Again", "open_position")],
                [Markup.button.callback("🏠 Back to Main", "back_to_main")],
            ]));
        }
    }
    catch (error) {
        console.error("Position creation error:", error);
        yield ctx.reply("An error occurred. Please try again.");
    }
}));
// Portfolio
const portfolioHandler = (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const userId = ctx.from.id.toString();
        const wallet = yield Wallet.findOne({ userId });
        if (!wallet) {
            return ctx.reply("Wallet not found. Please restart the bot.");
        }
        console.log("Checking positions for user:", userId);
        let positionData = null;
        for (const [tempId, data] of positionMappings) {
            if (tempId.startsWith(userId)) {
                positionData = data;
                console.log("Found matching position data:", positionData);
                break;
            }
        }
        if (!positionData) {
            return ctx.reply("No active positions found. Please create a position first.");
        }
        const { positionAddress, poolAddress } = positionData;
        console.log("Using position address:", positionAddress);
        const meteoraService = new MeteoraPositionService(connection);
        const positionDataResponse = yield meteoraService.fetchPositionData(positionAddress);
        if (!positionDataResponse) {
            return ctx.reply("Failed to fetch portfolio data. Please try again later.");
        }
        console.log("API Response:", positionDataResponse);
        // Fetch pool balances
        const { usdcBalance, solBalance } = yield fetchPoolTokenBalances(poolAddress);
        console.log("Raw pool balances:", { usdcBalance, solBalance });
        const adjustedPositionBalanceUSDC = usdcBalance / Math.pow(10, 6); // Adjust for USDC decimals
        const adjustedPositionBalanceSOL = solBalance / Math.pow(10, 9); // Adjust for SOL decimals
        console.log("Pool balances:", adjustedPositionBalanceUSDC, adjustedPositionBalanceSOL);
        // Fetch claimed fees from Meteora API (force fresh fetch)
        const earningUrl = `https://dlmm-api.meteora.ag/wallet/${wallet.publicKey}/${poolAddress}/earning`;
        const earningResponse = yield axios.get(earningUrl, { headers: { 'Cache-Control': 'no-cache' } });
        const earningData = earningResponse.data[0] || {};
        const totalFeeUsdClaimed = parseFloat(earningData.total_fee_usd_claimed) || 0;
        const totalFeeXClaimed = parseFloat(earningData.total_fee_x_claimed) / Math.pow(10, 6) || 0; // USDC, 6 decimals
        const totalFeeYClaimed = parseFloat(earningData.total_fee_y_claimed) / Math.pow(10, 9) || 0; // SOL, 9 decimals (lamports to SOL)
        console.log("Claimed fees from API:", { totalFeeUsdClaimed, totalFeeXClaimed, totalFeeYClaimed });
        const pairName = positionDataResponse.pair_address || "USDC-SOL";
        const totalValueUSD = (solBalance * SOL_PRICE_USD) + (adjustedPositionBalanceUSDC * USDC_PRICE_USD); // Updated calculation
        // Format balances like Meteora DEX UI
        const formattedSolBalance = `${solBalance.toFixed(6)} SOL ($${(adjustedPositionBalanceSOL * SOL_PRICE_USD).toFixed(2)})`;
        const formattedUsdcBalance = `${usdcBalance.toFixed(3)} USDC ($${(adjustedPositionBalanceUSDC * USDC_PRICE_USD).toFixed(2)})`;
        const unclaimedFeesUSDC = 0; // Placeholder: Update if API provides unclaimed fees
        const unclaimedFeesSOL = 0; // Placeholder: Update if API provides unclaimed fees
        const claimedFeesUSDC = totalFeeXClaimed; // From API
        const claimedFeesSOL = totalFeeYClaimed; // From API (in SOL, already converted)
        const feeTVLRatio = positionDataResponse.fee_apr_24h
            ? parseFloat(positionDataResponse.fee_apr_24h) * 100
            : 0.843;
        const inRange = true; // Placeholder: Update if API provides range status
        const autoRebalanceEnabled = wallet.autoRebalance || false;
        const currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const message = `<b>Portfolio Overview:</b>

<b>Total Positions: 1 | Total Pool Value: $${totalValueUSD.toLocaleString()}</b>

<a href="#">/1 ${pairName}</a>

Current Balance: 
${formattedSolBalance}
${formattedUsdcBalance}

Unclaimed Fees: 
${unclaimedFeesSOL.toFixed(6)} SOL ($0)
${unclaimedFeesUSDC.toFixed(4)} USDC ($0)

Claimed Fees: 
${claimedFeesSOL.toFixed(6)} SOL ($${totalFeeYClaimed.toFixed(2)})
${claimedFeesUSDC.toFixed(4)} USDC ($${totalFeeXClaimed.toFixed(2)})

24hr Fee / TVL: ${feeTVLRatio.toFixed(3)}%
In Range: ${inRange ? '🟢' : '🔴'}
Auto-Rebalancing Enabled: ${autoRebalanceEnabled ? '🟢' : '🔴'}

💡 Click a pair symbol to access position details.
${currentTime}`;
        const buttons = Markup.inlineKeyboard([
            [
                Markup.button.callback('Close', 'close_portfolio'),
                Markup.button.callback('Refresh', 'refresh_portfolio')
            ]
        ]);
        yield ctx.reply(message, {
            parse_mode: 'HTML',
            reply_markup: buttons.reply_markup,
            disable_web_page_preview: true
        });
    }
    catch (error) {
        console.error("Portfolio error:", error);
        ctx.reply("An error occurred while fetching your portfolio. Please try again.");
    }
});
bot.action('close_portfolio', (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    yield ctx.deleteMessage();
    yield ctx.answerCbQuery();
}));
bot.command("portfolio", portfolioHandler);
bot.hears("📊 Portfolio", portfolioHandler);
bot.action("refresh_portfolio", (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    yield ctx.deleteMessage();
    yield portfolioHandler(ctx);
}));
bot.action("portfolio", portfolioHandler);
bot.command('closeposition', (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    const userId = ctx.from.id.toString();
    console.log(`Starting closeposition for user ${userId}`);
    try {
        const wallet = yield Wallet.findOne({ userId });
        if (!wallet) {
            console.log(`No wallet found for user ${userId}`);
            return ctx.reply("Wallet not found. Please restart the bot.");
        }
        console.log(`Wallet found: ${wallet.publicKey}`);
        const poolAddress = wallet.poolAddress;
        if (!poolAddress) {
            console.log(`No pool address found for user ${userId}`);
            return ctx.reply("No pool address found. Please create a position first.");
        }
        console.log(`Using pool address: ${poolAddress}`);
        const userKeypair = Keypair.fromSecretKey(Uint8Array.from(Buffer.from(wallet.secretKey, "hex")));
        const loadingMsg = yield ctx.reply("⏳ Loading your positions...");
        try {
            const positionService = new MeteoraPositionService(connection);
            const userPositions = yield positionService.getUserPositions(userKeypair.publicKey, [poolAddress]);
            console.log(`Fetched ${userPositions.length} positions for user ${userId}`);
            if (ctx.chat && loadingMsg) {
                yield ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => { });
            }
            if (!userPositions || userPositions.length === 0) {
                console.log(`No active positions found for user ${userId}`);
                return ctx.reply("You don't have any active positions to close.");
            }
            positionMappings.forEach((_, key) => {
                if (key.startsWith(userId))
                    positionMappings.delete(key);
            });
            const positionButtons = userPositions.map((position, index) => {
                var _a, _b;
                const positionAddress = position.publicKey.toString();
                const tempId = `${userId}_${index}`;
                positionMappings.set(tempId, { poolAddress, positionAddress });
                const tokenA = ((_a = position.pool.tokenA) === null || _a === void 0 ? void 0 : _a.symbol) || "Token A";
                const tokenB = ((_b = position.pool.tokenB) === null || _b === void 0 ? void 0 : _b.symbol) || "Token B";
                return [
                    Markup.button.callback(`Close Position #${index + 1}: ${tokenA}/${tokenB}`, `close_position_${tempId}`)
                ];
            });
            yield ctx.reply("Select a position to close:", Markup.inlineKeyboard([
                ...positionButtons,
                [Markup.button.callback("🔙 Back to Main", "back_to_main")]
            ]));
        }
        catch (error) {
            console.error(`Error fetching positions for user ${userId}:`, error);
            if (ctx.chat && loadingMsg) {
                yield ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => { });
            }
            yield ctx.reply(`❌ Error loading positions: ${error instanceof Error ? error.message : "Unknown error"}`, Markup.inlineKeyboard([[Markup.button.callback("🏠 Back to Main", "back_to_main")]]));
        }
    }
    catch (error) {
        console.error(`Close position command failed for user ${userId}:`, error);
        yield ctx.reply("An unexpected error occurred. Please try again.");
    }
}));
bot.action(/close_position_(.+)/, (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    const tempId = ctx.match[1];
    const positionData = positionMappings.get(tempId);
    if (!positionData) {
        return ctx.reply("Position data not found. Please try again.");
    }
    const { poolAddress, positionAddress } = positionData;
    try {
        const wallet = yield Wallet.findOne({ userId: ctx.from.id.toString() });
        if (!wallet) {
            return ctx.reply("Wallet not found. Please restart the bot.");
        }
        yield ctx.reply("⚠️ Are you sure you want to close this position? This will remove all liquidity and claim any fees earned.", Markup.inlineKeyboard([
            [Markup.button.callback("✅ Yes, Close Position", `confirm_close_${tempId}`)],
            [Markup.button.callback("❌ Cancel", "back_to_main")]
        ]));
    }
    catch (error) {
        console.error("Close position action error:", error);
        yield ctx.reply("An error occurred. Please try again.");
    }
}));
bot.action(/confirm_close_(.+)/, (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    const tempId = ctx.match[1];
    const positionData = positionMappings.get(tempId);
    if (!positionData) {
        return ctx.reply("Position data not found. Please try again.");
    }
    const { poolAddress, positionAddress } = positionData;
    const userId = ctx.from.id.toString();
    console.log(`Confirming close for position ${positionAddress} in pool ${poolAddress} for user ${userId}`);
    try {
        const wallet = yield Wallet.findOne({ userId });
        if (!wallet) {
            console.log(`No wallet found for user ${userId}`);
            return ctx.reply("Wallet not found. Please restart the bot.");
        }
        const loadingMsg = yield ctx.reply("⏳ Closing position...");
        try {
            const userKeypair = Keypair.fromSecretKey(Uint8Array.from(Buffer.from(wallet.secretKey, "hex")));
            const positionService = new MeteoraPositionService(connection);
            const dlmmPool = yield positionService.createDLMMInstance(poolAddress);
            const txSignatures = yield positionService.removePositionLiquidity(dlmmPool, userKeypair, positionAddress);
            console.log(`Position ${positionAddress} closed successfully with tx: ${txSignatures}`);
            positionMappings.delete(tempId);
            wallet.poolAddress = "";
            wallet.autoRebalance = false;
            wallet.positionAmount = 0;
            yield wallet.save();
            console.log(`Cleared pool address and rebalancing state for user ${userId} after closing position`);
            // Stop rebalancing process if running
            const process = rebalancingProcesses.get(userId);
            if (process) {
                process.cronJob.stop();
                rebalancingProcesses.delete(userId);
                console.log(`Stopped rebalancing for user ${userId}`);
            }
            if (ctx.chat && loadingMsg) {
                yield ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => { });
            }
            const successMessage = [
                "✅ Position closed successfully!",
                "",
                "💰 Liquidity and earned fees have been returned to your wallet.",
                `Transactions: ${txSignatures.length}`,
                "",
                "🔍 Transaction Details:",
                ...txSignatures.map((sig, i) => `Tx ${i + 1}: ${sig}`)
            ].join("\n");
            yield ctx.reply(successMessage, Markup.inlineKeyboard([
                [Markup.button.url("View on Solscan", `https://solscan.io/tx/${txSignatures[0]}`)],
                [Markup.button.callback("🏠 Back to Main", "back_to_main")],
            ]));
        }
        catch (error) {
            console.error(`Error closing position ${positionAddress} for user ${userId}:`, error);
            if (ctx.chat && loadingMsg) {
                yield ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => { });
            }
            yield ctx.reply(`❌ Error closing position: ${error instanceof Error ? error.message : "Unknown error"}`, Markup.inlineKeyboard([[Markup.button.callback("🏠 Back to Main", "back_to_main")]]));
        }
    }
    catch (error) {
        console.error(`Confirm close failed for user ${userId}:`, error);
        yield ctx.reply("An unexpected error occurred. Please try again.");
    }
}));
bot.on("text", (ctx) => __awaiter(void 0, void 0, void 0, function* () {
    if (!ctx.session)
        ctx.session = {};
    if (ctx.session.awaitingPositionAmount) {
        try {
            const amount = parseFloat(ctx.message.text.trim());
            if (isNaN(amount) || amount <= 0) {
                return ctx.reply("❌ Invalid amount. Please enter a valid number greater than 0.", Markup.inlineKeyboard([[Markup.button.callback("Cancel", "back_to_main")]]));
            }
            const wallet = yield Wallet.findOne({ userId: ctx.from.id.toString() });
            if (!wallet) {
                return ctx.reply("Wallet not found. Please restart the bot.");
            }
            const balance = yield connection.getBalance(new PublicKey(wallet.publicKey));
            const solBalance = balance / LAMPORTS_PER_SOL;
            if (solBalance < 0.056565200) {
                return ctx.reply(`We recommend keeping at least 0.05 SOL for any transaction.\n\n` +
                    `Your balance: ${solBalance.toFixed(9)} SOL ($${(solBalance * SOL_PRICE_USD).toFixed(2)})\n` +
                    `Please ensure you have enough SOL`, Markup.inlineKeyboard([
                    [Markup.button.callback("👛 Check Wallet", "wallet")],
                    [Markup.button.callback("❌ Cancel", "back_to_main")]
                ]));
            }
            const message = [
                `📊 Position Summary`,
                `Amount: ${amount} ${ctx.session.selectedToken}`,
                `\nWould you like to enable auto-rebalancing and monitoring every 1hr?`
            ].join("\n");
            ctx.session.awaitingPositionAmount = false;
            yield ctx.reply(message, Markup.inlineKeyboard([
                [
                    Markup.button.callback("✅ Yes", `create_position_${ctx.session.selectedToken}_${amount}_true`),
                    Markup.button.callback("❌ No", `create_position_${ctx.session.selectedToken}_${amount}_false`)
                ]
            ]));
        }
        catch (error) {
            console.error("Error processing amount:", error);
            ctx.reply("An error occurred. Please try again.");
        }
        return;
    }
    if (ctx.session.awaitingSendSol) {
        const lastMessage = ctx.message.text;
        if (lastMessage.split(" ").length === 2) {
            const [recipientAddress, amountStr] = lastMessage.split(" ");
            const amount = parseFloat(amountStr);
            if (!amount || amount <= 0) {
                return ctx.reply("Invalid amount. Please try again.");
            }
            try {
                const wallet = yield Wallet.findOne({ userId: ctx.from.id.toString() });
                if (!wallet) {
                    return ctx.reply("Wallet not found. Please restart the bot.");
                }
                const balance = yield connection.getBalance(new PublicKey(wallet.publicKey));
                const solBalance = balance / LAMPORTS_PER_SOL;
                if (solBalance < amount) {
                    return ctx.reply("Insufficient balance!");
                }
                yield ctx.reply(`Confirm transaction:\n\n` + `To: ${recipientAddress}\n` + `Amount: ${amount.toFixed(6)} SOL ($${(amount * SOL_PRICE_USD).toFixed(2)})\n` + `From: ${wallet.publicKey}\n\n` + `Please confirm:`, Markup.inlineKeyboard([
                    [Markup.button.callback("✅ Confirm", `confirm_send_${recipientAddress}_${amount}`), Markup.button.callback("❌ Cancel", "back_to_main")],
                ]));
                ctx.session.awaitingSendSol = false;
            }
            catch (error) {
                ctx.reply("Invalid address format or error checking balance.");
            }
        }
        return;
    }
}));
bot.action("wallet", walletHandler);
const app = express();
const port = process.env.PORT || 8443 || 3000 || 8000 || 8080;
console.log(`Starting Cleopetra Bot server on port ${port}`);
app.use(express.json()); // Parse JSON for Telegram webhook
// Relative webhook path for handling updates locally
const secretPath = `/telegraf/${bot.secretPathComponent()}`;
// Webhook endpoint for handling updates (local path)
app.post(secretPath, (req, res) => {
    bot.handleUpdate(req.body, res); // Handle Telegram webhook updates
    res.status(200).send('Webhook received');
});
// Health check endpoint for Cloud Run
app.get('/', (req, res) => {
    res.status(200).send('Cleopetra Bot is running!');
});
// Start the bot with conditional webhook or polling
function startBot() {
    return __awaiter(this, void 0, void 0, function* () {
        const webhookUrl = process.env.WEBHOOK_URL ? `https://${process.env.WEBHOOK_URL}${secretPath}` : null;
        if (webhookUrl) {
            // Webhook mode for Cloud Run
            try {
                yield bot.telegram.setWebhook(webhookUrl);
                console.log(`Webhook set to ${webhookUrl}`);
                app.listen(port, () => {
                    console.log(`Bot server running on port ${port} in webhook mode`);
                });
            }
            catch (error) {
                console.error('Failed to set webhook:', error);
                process.exit(1);
            }
        }
        else {
            // Polling mode for local development
            console.log('WEBHOOK_URL not set, starting bot in polling mode');
            bot.launch().then(() => console.log('Bot started in polling mode'));
        }
    });
}
startBot();
//# sourceMappingURL=index.js.map