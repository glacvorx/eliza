import {
    IAgentRuntime,
    elizaLogger,
    generateText,
    ModelClass,
    stringToUuid,
    composeContext,
} from "@elizaos/core";
import { Tweet } from "agent-twitter-client";

/**
 * Template for determining if CARV on-chain data would enhance your reply to a tweet
 */
export const carvActionTemplate =
    `
# INSTRUCTIONS: Determine if CARV on-chain data would enhance your reply to this tweet:

Tweet: {{currentPost}}

Guidelines:
- You've ALREADY decided to engage with this tweet
- CARV data significantly enhances replies related to blockchain, crypto, Web3, and on-chain activities
- ALWAYS fetch CARV data when the tweet relates to ANY of these categories:

1. TOKEN & MARKET DATA (ALWAYS FETCH if mentioned):
   - ANY mention of known token names (with or without $ prefix like ETH, SOL, WOOF, BTC)
   - Token keywords: "holders", "supply", "price", "market cap", "volume", "transfers", "mint"
   - Questions including "how many", "price of", "total supply", "market cap" with token names
   - Market trends, trading volume, liquidity, or price movements
   - Whale activity, large transactions, or market sentiment

2. WALLET & IDENTITY VERIFICATION:
   - ANY mention of wallets, addresses, or blockchain identity
   - Requests to verify someone's on-chain activity or holdings
   - Questions about transaction history or wallet reputation
   - Cross-referencing Twitter/Discord identities with on-chain activities

3. BLOCKCHAIN ACTIVITY & GOVERNANCE:
   - Questions about on-chain events (transactions, airdrops, staking)
   - DAO governance discussions, proposals, or voting
   - Treasury management or fund allocation topics
   - Mentions of gas fees, transaction status, or network activity

4. DEFI & TRADING:
   - Questions about yields, staking rewards, or farming strategies
   - Cross-chain comparisons or bridging discussions
   - Trading strategies, portfolio management, or DeFi protocols
   - Liquidity pools, swaps, or arbitrage opportunities

5. GAMING & NFTs:
   - Blockchain gaming discussions or in-game assets
   - NFT valuation, trading, or ownership verification
   - Game economy, player progression, or asset recommendations

6. ECOSYSTEM & MULTI-CHAIN DATA:
   - Discussions comparing multiple blockchains or L2s (Ethereum, Arbitrum, Base, Solana, etc.)
   - Questions about ecosystem growth or adoption metrics
   - Cross-chain data or multi-network statistics
   - Network health, validators, or infrastructure metrics

IMPORTANT: Text preprocessing may remove the $ prefix from token names and convert to lowercase.
Focus on the token name itself (ETH, SOL, WOOF) rather than the $ symbol.

Actions (respond only with tags):
[FETCH_CARV] - On-chain data would enhance the reply (mentions of tokens, crypto terms, or blockchain concepts)
[SKIP_CARV] - The tweet has NO connection to blockchain, crypto, or on-chain data

# Respond with a single action tag only. When in doubt, choose [FETCH_CARV].
`;

/**
 * Interface for CARV analysis result
 */
export interface IAnalysisResult {
    context?: string;
    code?: number;
    msg?: string;
    data?: {
        column_infos?: string[];
        rows?: any[];
        [key: string]: any;
    };
    error?: {
        code?: string;
        message?: string;
        details?: any;
    };
}

/**
 * Creates the initial tweet state for CARV processing
 */
export async function createInitialState(
    runtime: IAgentRuntime,
    twitterUsername: string,
    tweet: any,
    formattedConversation: string,
    imageDescriptions: string[] = [],
    quotedContent: string = ""
): Promise<any> {
    const roomId = stringToUuid(
        tweet.conversationId + "-" + runtime.agentId
    );

    return await runtime.composeState(
        {
            userId: runtime.agentId,
            roomId,
            agentId: runtime.agentId,
            content: { text: tweet.text, action: "" },
        },
        {
            twitterUserName: twitterUsername,
            currentPost: `From @${tweet.username}: ${tweet.text}`,
            formattedConversation,
            imageContext:
                imageDescriptions.length > 0
                    ? `\nImages in Tweet:\n${imageDescriptions
                        .map((desc, i) => `Image ${i + 1}: ${desc}`)
                        .join("\n")}`
                    : "",
            quotedContent,
        }
    );
}

/**
 * Parse a response text to determine CARV actions
 * This is a specialized version of parseActionResponseFromText for CARV data
 */
export const parseCARVActionResponseFromText = (
    text: string
): { actions: { FETCH_CARV: boolean } } => {
    const actions = {
        FETCH_CARV: false
    };

    // Regex patterns for CARV actions
    const fetchCARVPattern = /\[FETCH_CARV\]/i;
    const skipCARVPattern = /\[SKIP_CARV\]/i;

    // Check with regex - if FETCH_CARV is present, set to true
    if (fetchCARVPattern.test(text)) {
        actions.FETCH_CARV = true;
    }
    
    // If SKIP_CARV is present, explicitly set FETCH_CARV to false
    if (skipCARVPattern.test(text)) {
        actions.FETCH_CARV = false;
    }

    // Also do line by line parsing as backup
    const lines = text.split("\n");
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "[FETCH_CARV]") actions.FETCH_CARV = true;
        if (trimmed === "[SKIP_CARV]") actions.FETCH_CARV = false;
    }

    return { actions };
};

/**
 * Generate a CARV action decision based on the tweet context
 * This is a specialized version of generateTweetActions for CARV data
 */
export async function generateCARVAction({
    runtime,
    context,
    modelClass,
}: {
    runtime: IAgentRuntime;
    context: string;
    modelClass: ModelClass;
}): Promise<{ FETCH_CARV: boolean } | null> {
    let retryDelay = 1000;
    while (true) {
        try {
            const response = await generateText({
                runtime,
                context,
                modelClass,
            });
            elizaLogger.debug(
                "[CARV] Received response from generateText for CARV action:",
                response
            );
            const { actions } = parseCARVActionResponseFromText(response.trim());
            if (actions) {
                elizaLogger.debug("[CARV] Parsed CARV action:", actions);
                return actions;
            } else {
                elizaLogger.debug("[CARV] generateCARVAction no valid response");
            }
        } catch (error) {
            elizaLogger.error("[CARV] Error in generateCARVAction:", error);
            if (
                error instanceof TypeError &&
                error.message.includes("queueTextCompletion")
            ) {
                elizaLogger.error(
                    "TypeError: Cannot read properties of null (reading 'queueTextCompletion')"
                );
            }
        }
        elizaLogger.log(`[CARV] Retrying in ${retryDelay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay *= 2;
    }
}

/**
 * Determines whether CARV data should be fetched for a tweet
 */
export async function shouldFetchCARVData(
    runtime: IAgentRuntime,
    state: any
): Promise<boolean> {
    try {
        // Extract tweet information directly from state
        // The twitterUserName property is added in createInitialState
        const tweetUsername = state.twitterUserName || '';

        // Create the action context using the provided state
        const carvActionContext = composeContext({
            state,
            template: carvActionTemplate,
        });

        // Get CARV action decision using the specialized CARV action generator
        const carvActionResponse = await generateCARVAction({
            runtime: runtime,
            context: carvActionContext,
            modelClass: ModelClass.SMALL,
        });

        if (carvActionResponse && carvActionResponse.FETCH_CARV) {
            elizaLogger.log(`[CARV] Decision: Should fetch CARV data for user: ${tweetUsername}`);
            return true;
        } else {
            elizaLogger.log(`[CARV] Decision: Skip CARV data fetch for user: ${tweetUsername}`);
            return false;
        }
    } catch (error) {
        elizaLogger.error("[CARV] Error in CARV decision process:", error);
        return false; // Default to not fetching on error
    }
}

/**
 * Query the CARV LLM SQL API directly with tweet content
 */
export async function queryLLMSQLAPI(
    runtime: IAgentRuntime,
    tweetContent: string
): Promise<IAnalysisResult | null> {
    try {
        elizaLogger.debug(`[CARV] Querying CARV LLM SQL API for tweet: "${tweetContent.substring(0, 100)}..."`);

        const payload = {
            question: tweetContent
        };

        const carvApiBaseUrl = 'https://interface.carv.io';
        const endpoint = '/ai-agent-backend/sql_query_by_llm';

        const apiKey = runtime.getSetting('CARV_DATA_API_KEY');
        if (!apiKey) {
            elizaLogger.error('[CARV] No API key available for CARV API');
            return null;
        }

        const response = await fetch(`${carvApiBaseUrl}${endpoint}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': apiKey
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            elizaLogger.error(`[CARV] API error: ${response.status} - ${errorText}`);
            return {
                error: {
                    code: response.status.toString(),
                    message: `API error: ${response.status}`,
                    details: errorText
                }
            };
        }

        const result = await response.json();
        elizaLogger.debug('[CARV] Received response from API', result);
        
        return result;
    } catch (error) {
        elizaLogger.error(`[CARV] Error querying CARV LLM SQL API: ${error}`);
        return null;
    }
}

/**
 * Analyzes data returned from CARV to generate insights
 */
export async function analyzeData(
    runtime: IAgentRuntime,
    data: any,
    query: string,
): Promise<string> {
    try {
        if (!data) {
            return "No on-chain data available for analysis.";
        }

        // Create the analysis prompt
        const prompt = `
        # On-Chain Data Analysis Task

        ## Query:
        "${query}"

        ## Data Retrieved:
        ${JSON.stringify(data, null, 2)}

        ## Response Instructions:
        First, determine the type of query:
        
        1. If this is a straightforward factual question (e.g., "What's the price of ETH?", "How many transactions did this address make?", "What's the total supply of this token?"), then:
           - Provide a direct, concise answer using only the necessary data
           - Format numbers appropriately (e.g., "$1,234.56" for prices)
           - No need for additional analysis or insights
        
        2. If this requires analytical insights (e.g., "Analyze this wallet's activity", "Is this suspicious behavior?", "What patterns do you see?"), then provide:
           - A concise summary of what the blockchain data shows
           - Notable patterns, anomalies, or significant metrics
           - If relevant, whether the data shows:
              * Whale activity (large transactions or holdings)
              * Suspicious patterns (unusual timing, circular transactions)
              * Market movements or trading patterns
              * New or notable projects gaining traction
           - Conclude with 1-2 key takeaways that would be valuable for a tweet response in 1-2 sentences

        Respond in a clear, conversational tone appropriate for a tweet response.
        `;

        // Generate the analysis
        const analysis = await generateText({
            runtime: runtime,
            context: prompt,
            modelClass: ModelClass.LARGE,
        });
        elizaLogger.debug("[CARV] Analysis:", analysis);

        return analysis || "Could not generate analysis from the on-chain data.";
    } catch (error) {
        elizaLogger.error(`[CARV] Error analyzing data: ${error}`);
        return "Error analyzing the on-chain data.";
    }
}

/**
 * Processes CARV data for a tweet using the LLM SQL API
 * This is the main function that orchestrates the entire CARV data pipeline
 */
export async function processCARVData(
    runtime: IAgentRuntime,
    twitterUsername: string,
    tweet: Tweet,
    formattedConversation: string,
    imageDescriptions: string[] = [],
    quotedContent: string = ""
): Promise<string> {
    let CARVInsights = "";
    
    try {
        // 1. Create initial state for decision making
        const initialState = await createInitialState(
            runtime,
            twitterUsername,
            tweet,
            formattedConversation,
            imageDescriptions,
            quotedContent
        );

        // 2. Determine if we should fetch CARV data
        const shouldFetch = await shouldFetchCARVData(runtime, initialState);

        if (shouldFetch) {
            // Get the tweet text from the tweet object
            const tweetText = tweet.text || '';

            if (tweetText) {
                elizaLogger.log(`[CARV] Processing on-chain data for tweet from @${tweet.username}`);
                elizaLogger.log(`[CARV] Tweet content: "${tweetText.substring(0, 50)}..."`);

                // 3. Query the CARV LLM SQL API directly with the tweet content
                const queryResult = await queryLLMSQLAPI(runtime, tweetText);

                if (queryResult?.data) {
                    // 4. Generate insights based on the data
                    CARVInsights = await analyzeData(
                        runtime,
                        queryResult.data,
                        tweetText
                    );

                    // Format the insights for Twitter
                    if (CARVInsights) {
                        // Add a header to better organize the insights
                        CARVInsights = `Based on the latest on-chain data:\n${CARVInsights}`;

                        // Log successful retrieval
                        elizaLogger.log('[CARV] Successfully retrieved on-chain insights', {
                            tweetId: tweet.id,
                            username: tweet.username,
                            insightLength: CARVInsights.length
                        });
                    } else {
                        elizaLogger.warn('[CARV] Analysis returned empty insights');
                    }
                } else if (queryResult?.error) {
                    elizaLogger.error(`[CARV] API Error: ${queryResult.error.message}`, queryResult.error);
                    CARVInsights = `Could not generate on-chain analysis: ${queryResult.error.message}`;
                } else {
                    elizaLogger.warn('[CARV] No data returned from CARV API');
                    CARVInsights = "Could not generate on-chain analysis: No data returned from API.";
                }
            } else {
                elizaLogger.warn('[CARV] Tweet has no text content');
            }
        } else {
            elizaLogger.log('[CARV] Decision: Not fetching CARV data for this tweet');
        }
    } catch (error) {
        elizaLogger.error(`[CARV] Error in CARV data processing: ${error}`, error);
        CARVInsights = `Error analyzing on-chain data: ${error}`;
    }

    return CARVInsights;
}
