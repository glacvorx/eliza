import { elizaLogger, IAgentRuntime } from "@elizaos/core";
import { TwitterConfig } from "./environment";
import { ClientBase } from "./base";

interface CoinGeckoResponse {
    id: string;
    symbol: string;
    name: string;
    current_price: number;
    market_cap: number;
    market_cap_rank: number;
    price_change_percentage_24h: number;
    total_volume: number;
}

async function fetchGamingCoins(apiKey: string): Promise<CoinGeckoResponse[] | null> {
    const url = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=gaming&order=market_cap_desc&per_page=250";

    let attempts = 0;
    const maxAttempts = 3;
    const retryDelay = 60000; // 1 minute in milliseconds

    while (attempts < maxAttempts) {
        try {
            const options = {
                method: 'GET',
                headers: {
                    'accept': 'application/json',
                    'x-cg-demo-api-key': apiKey
                }
            };

            const response = await fetch(url, options);
            if (!response.ok) {
                elizaLogger.error(`[CoinGecko] HTTP error! status: ${response.status}`);
                attempts++;
                if (attempts === maxAttempts) {
                    return null;
                }
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                continue;
            }
            const data = await response.json();
            return data;
        } catch (error) {
            attempts++;
            elizaLogger.error(`[CoinGecko] Error fetching data: ${error.message}`);
            if (attempts === maxAttempts) {
                return null;
            }
            elizaLogger.error(`[CoinGecko] Retrying in 1 minute... (Attempt ${attempts}/${maxAttempts})`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }
    return null;
}

async function generateTweetContent(data: CoinGeckoResponse[]): Promise<string> {
    // Sort by price change percentage in descending order
    const sortedByPriceChange = [...data].sort((a, b) => b.price_change_percentage_24h - a.price_change_percentage_24h);

    // Get top 3 gainers
    const topGainers = sortedByPriceChange.slice(0, 3);

    const gainersText = topGainers.map(coin => 
        `$${coin.symbol.toUpperCase()} (${coin.price_change_percentage_24h >= 0 ? '+' : ''}${coin.price_change_percentage_24h.toFixed(2)}%)`
    ).join(", ");

    // Commented out losers section for future use
    /*
    const topLosers = sortedByPriceChange.slice(-3).reverse();
    const losersText = topLosers.map(coin => 
        `$${coin.symbol.toUpperCase()} (${coin.price_change_percentage_24h >= 0 ? '+' : ''}${coin.price_change_percentage_24h.toFixed(2)}%)`
    ).join(", ");
    */

    return `Web3 Gaming Token Gainers: ${gainersText}.\n\nPowered by CoinGecko.`;
    // return `Web3 Gaming Token Gainers: ${gainersText}.\n\nWeb3 Gaming Token Losers: ${losersText}.\n\nPowered by CoinGecko.`;
}

export async function runCoinGecko(twitterConfig: TwitterConfig, client: ClientBase, runtime: IAgentRuntime): Promise<{success: boolean; error?: string}> {
    try {
        let tweetPostedSuccessfully = false;

        // Fetch CoinGecko data
        const gamingCoins = await fetchGamingCoins(twitterConfig.TWITTER_COINGECKO_API_KEY);
        if (!gamingCoins) {
            elizaLogger.error("[CoinGecko] Failed to fetch gaming coins data after all retries");
            return { success: false, error: "Failed to fetch gaming coins data" };
        }

        // Generate tweet content
        const tweetContent = await generateTweetContent(gamingCoins);

        // Check for dry run mode
        if (twitterConfig.TWITTER_DRY_RUN) {
            elizaLogger.info(`[CoinGecko] Dry run: Would have posted tweet: ${tweetContent}`);
            tweetPostedSuccessfully = true;
            return { success: true };
        }

        // Post tweet
        try {
            const result = await client.twitterClient.sendTweet(tweetContent);
            const body = await result.json();

            // Check for Twitter API errors
            if (body.errors) {
                const error = body.errors[0];
                elizaLogger.error(`[CoinGecko] Twitter API error (${error.code}): ${error.message}`);
                return { success: false, error: `Failed to post tweet: ${error.message}` };
            }

            // Check for successful tweet creation
            if (!body?.data?.create_tweet?.tweet_results?.result) {
                elizaLogger.error("[CoinGecko] No tweet result in response");
                return { success: false, error: "Failed to post tweet: No tweet result in response" };
            }

            elizaLogger.info(`[CoinGecko] Posted tweet: ${tweetContent}`);
            tweetPostedSuccessfully = true;
            return { success: true };

        } catch (e) {
            elizaLogger.error(`[CoinGecko] Error posting tweet: ${e.message}`);
            return { success: false, error: `Failed to post tweet: ${e.message}` };
        }

    } catch (error) {
        elizaLogger.error(`[CoinGecko] Fatal error: ${error.message}`);
        return { success: false, error: error.message };
    }
}
