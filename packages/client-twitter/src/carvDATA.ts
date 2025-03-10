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
- Only fetch CARV data when it would MEANINGFULLY enhance your reply
- Consider:
  - Tweet mentions specific blockchain addresses, transactions, or tokens
  - Tweet asks about on-chain activity, wallet balances, or transaction history
  - Tweet discusses blockchain trends where on-chain data analysis would provide context
  - Tweet references a specific Twitter user whose on-chain activities could be relevant
  - Tweet mentions Ethereum, Bitcoin, Solana, or Base blockchain data that could be queried
  - Skip fetching for general crypto discussions without specific on-chain data needs
  - Skip for non-technical topics where blockchain data adds little value

Actions (respond only with tags):
[FETCH_CARV] - On-chain data would significantly enhance the quality of the reply (8+/10 relevance)
[SKIP_CARV] - On-chain data would add little value or be irrelevant to this specific reply

# Respond with a single action tag only.
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
            template:
                runtime.character.templates
                    ?.carvActionTemplate ||
                carvActionTemplate,
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

        // Prepare the request payload with the tweet content
        const payload = {
            question: `Please analyze this tweet: "${tweetContent}"`
        };

        // Use fetch to directly call the CARV API endpoint
        // The exact base URL should be configured properly
        const carvApiBaseUrl = 'https://interface.carv.io';
        const endpoint = '/ai-agent-backend/sql_query_by_llm';

        // Get API key from environment or runtime configuration
        const apiKey = runtime.getSetting('CARV_API_KEY');

        if (!apiKey) {
            elizaLogger.error('[CARV] No API key available for CARV API');
            return null;
        }

        const response = await fetch(`${carvApiBaseUrl}${endpoint}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
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
            maxTokens: 1000,
        });

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
                elizaLogger.log(`[CARV] Processing on-chain data for tweet`);
                
                // 3. Query the CARV LLM SQL API directly with the tweet content
                const queryResult = await queryLLMSQLAPI(runtime, tweetText);
                
                if (queryResult?.data) {
                    // 4. Generate insights based on the data
                    CARVInsights = await analyzeData(
                        runtime,
                        queryResult.data,
                        tweetText
                    );
                    
                    elizaLogger.log('[CARV] Successfully processed and analyzed on-chain data');
                } else if (queryResult?.error) {
                    elizaLogger.error(`[CARV] Error from CARV API: ${queryResult.error.message}`);
                } else {
                    elizaLogger.log('[CARV] No data returned from CARV API');
                }
            } else {
                elizaLogger.log('[CARV] No tweet text available to process');
            }
        } else {
            elizaLogger.log('[CARV] Skipping CARV data fetch based on decision');
        }
    } catch (error) {
        elizaLogger.error(`[CARV] Error in processCARVData: ${error}`);
    }
    
    return CARVInsights;
}
