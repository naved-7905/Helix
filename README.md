# Helix is a seamless platform for liquidity provisioning on Solana DEXes, directly from Telegram!

Enter a token, pick an LP strategy of your choice and create the position — the agent finds optimal pools and auto-rebalance positions when needed to maximise fees and reduce impermanent loss.

**Live Demo (Telegram):** [https://t.me/Helix_0bot](https://t.me/Helix_0bot)

Helix Bot is a sophisticated Telegram bot designed to simplify and automate liquidity provision (LP) on Solana's Meteora DLMM (Dynamic Liquidity Market Maker) pools. It leverages AI (OpenAI's GPT) to assist with rebalancing decisions, provides a seamless Telegram-based UI for managing positions, and includes integrated Solana wallet management.

## ✨ Features

*   **🤖 AI-Assisted Auto-Rebalancing:**
    *   Monitors your Meteora DLMM position prices periodically (every 30 seconds by default).
    *   Consults OpenAI (GPT-4 Turbo) when price deviations exceed a configurable threshold (e.g., 0.1%).
    *   Automatically rebalances positions by removing and re-adding liquidity based on AI recommendation and threshold checks.
*   **💧 Meteora DLMM Liquidity Provision:**
    *   Guides users to select optimal Meteora pools for a chosen token (e.g., USDC-SOL).
    *   Creates new LP positions with user-specified amounts.
    *   Removes liquidity and closes positions.
*   **👛 Integrated Solana Wallet Management:**
    *   Automatically generates a new Solana wallet for first-time users.
    *   Displays wallet address and SOL balance (with USD equivalent).
    *   Securely shows the private key upon request (with strong security warnings).
    *   Allows users to send SOL to other addresses.
*   **📊 Portfolio Tracking:**
    *   Displays active LP positions with details like pool name, current balance (SOL & USDC), claimed fees, 24hr Fee/TVL ratio, and auto-rebalancing status.
    *   Fetches real-time data from Meteora APIs.
*   **📈 Token Information:**
    *   Fetches and displays price, market cap, and volume statistics for supported tokens (currently USDC via CoinGecko).
*   **⚙️ Configurable & User-Friendly:**
    *   Easy-to-use Telegram commands and inline keyboard buttons.
    *   Settings for auto-rebalancing.
    *   Help and refresh functionalities.
*   **🌐 Webhook & Polling Support:**
    *   Supports Telegram Bot API via webhooks (for production/Cloud Run) or polling (for local development).
    *   Includes an Express server for webhook handling and health checks.
*   **🔒 Secure & Self-Contained:**
    *   Manages user wallets (public/secret keys) stored in a MongoDB database.
    *   Uses `.env` for secure configuration of API keys and sensitive data.

## 🛠️ Technologies Used

*   **Backend:** Node.js, Express.js
*   **Language:** TypeScript
*   **Telegram Bot:** Telegraf.js
*   **Solana Interaction:** `@solana/web3.js`, `@meteora-ag/dlmm`, `@coral-xyz/anchor`
*   **AI Integration:** OpenAI Node.js Library (GPT-4 Turbo)
*   **Database:** MongoDB with Mongoose
*   **Scheduling:** `node-cron`
*   **API Calls:** `axios`, `node-fetch`
*   **Environment Management:** `dotenv`
*   **Containerization:** Docker

## 📋 Prerequisites

*   Node.js (v20 or later recommended - as per Dockerfile)
*   npm or yarn
*   MongoDB instance (local or cloud-hosted)
*   (Optional) Docker

## 🚀 Getting Started

1.  **Clone the repository:**
    ```bash
    git clone <repository-url>
    cd Helix
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    # or
    yarn install
    ```

3.  **Set up Environment Variables:**
    Create a `.env` file in the root of the project and populate it with your credentials. See `.env.example` for the required variables:

    ```ini
    # .env.example

    # Telegram Bot Token from BotFather
    TELEGRAM_BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN

    # OpenAI API Key
    OPENAI_API_KEY=sk-YOUR_OPENAI_API_KEY

    # Solana RPC Provider (Helius, QuickNode, Alchemy, or public)
    # If using Helius or another provider that includes the API key in the URL:
    HELIUS_API_KEY=YOUR_HELIUS_API_KEY_OR_FULL_RPC_URL 
    # Example for public RPC (less reliable for production):
    # HELIUS_API_KEY=https://api.mainnet-beta.solana.com

    # MongoDB Connection URI
    MONGODB_URI=mongodb://localhost:27017/solana_bot 
    # Or your MongoDB Atlas URI: mongodb+srv://<user>:<password>@cluster.mongodb.net/solana_bot?retryWrites=true&w=majority

    # Port for the Express server (used for webhook)
    PORT=8080

    # (Optional) Your public-facing URL for Telegram Webhook (e.g., your Cloud Run URL without https://)
    # Example: your-app-name.run.app
    WEBHOOK_URL=your-domain.com 
    ```

    *   `TELEGRAM_BOT_TOKEN`: Get this from BotFather on Telegram.
    *   `OPENAI_API_KEY`: Your API key from OpenAI.
    *   `HELIUS_API_KEY`: Your Helius API key (the code constructs the URL like `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`) or you can put a full RPC URL here if not using Helius in this specific format.
    *   `MONGODB_URI`: Your MongoDB connection string.
    *   `PORT`: The port on which the Express server will run (primarily for webhook mode).
    *   `WEBHOOK_URL`: (Optional) If deploying with webhooks (e.g., to Cloud Run), set this to your publicly accessible domain (without `https://` or the path). The bot will construct the full webhook path.

4.  **Compile TypeScript (or use ts-node):**
    The project uses `ts-node` for development, so compilation is handled on the fly. For production, you might want to build:
    ```bash
    npm run tsc # (Assuming you add a "tsc": "tsc" script to package.json or run ./node_modules/.bin/tsc)
    # Then run from ./dist/index.js
    ```

## 🏃 Running the Bot

### Local Development (Polling Mode)

If `WEBHOOK_URL` is not set in your `.env` file, the bot will start in polling mode.

```bash
npm start
