import { elizaLogger, IAgentRuntime } from "@elizaos/core";
import { TwitterConfig } from "./environment";
import { ClientBase } from "./base";
import {
    ExecutableGameFunctionResponse,
    ExecutableGameFunctionStatus,
    GameAgent,
    GameFunction,
    GameWorker,
    LLMModel,
} from "@virtuals-protocol/game";
import { formatTweetUsingTemplate } from "./formatting";

export async function runVirtualsGAME(twitterConfig: TwitterConfig, client: ClientBase, runtime: IAgentRuntime): Promise<{success: boolean; error?: string}> {
    try {
        let tweetPostedSuccessfully = false;

        // Fetch timeline data for context
        let timelineContext = "";
        try {
            // First try to get cached timeline
            let timeline = await client.getCachedTimeline();

            // If no cached timeline, fetch new timeline
            if (!timeline || timeline.length === 0) {
                elizaLogger.log("[Virtuals GAME] No cached timeline found, fetching new timeline...");
                timeline = await client.fetchHomeTimeline(50);
                await client.cacheTimeline(timeline);
            }

            if (timeline && timeline.length > 0) {
                timelineContext = timeline.map(tweet =>
                    `Tweet from @${tweet.username}: ${tweet.text}`
                ).join("\n\n");

                elizaLogger.debug("[Virtuals GAME] Timeline context generated from recent tweets");
            }
        } catch (error) {
            elizaLogger.error("[Virtuals GAME] Error fetching timeline:", error);
            // Continue execution even if timeline fetch fails
        }

        // Create the post tweet function
        const postTweetFunction = new GameFunction({
            name: "post_tweet",
            description: "Post a highly specific, data-driven tweet about web3 gaming that builds on or responds to recent timeline discussions",
            args: [
                { 
                    name: "tweet", 
                    description: "The tweet content that must follow Agent_YP's style: lowercase except tickers/names, no emojis, one sentence or two short sentences. MUST include specific metrics, project names, or concrete observations. NEVER use generic statements like 'space is booming' or 'strong growth'. Instead cite specific numbers, trends, or project developments. Should not start with a user mention." 
                },
                { 
                    name: "tweet_reasoning", 
                    description: "Explain which specific data points, timeline tweets, or market events influenced this tweet. Reference concrete information rather than general trends." 
                },
            ] as const,
            executable: async (args) => {
                try {
                    const formattedTweet = await formatTweetUsingTemplate(
                        runtime,
                        args.tweet
                    );

                    // Sanitize the tweet content before posting
                    const rawTweetContent = formattedTweet;
                    let tweetTextForPosting = rawTweetContent.trim();

                    // Final cleaning
                    const removeQuotes = (str: string) => str.replace(/^['"](.*)['"]$/, "$1");
                    const fixNewLines = (str: string) => str.replaceAll(/\\n/g, "\n\n"); // ensures double spaces

                    // Apply final cleaning
                    tweetTextForPosting = removeQuotes(fixNewLines(tweetTextForPosting));

                    // Check for dry run mode
                    if (twitterConfig.TWITTER_DRY_RUN) {
                        elizaLogger.info(`[Virtuals GAME] Dry run: Would have posted tweet: ${tweetTextForPosting}`);
                        elizaLogger.info(`[Virtuals GAME] Dry run: Reasoning: ${args.tweet_reasoning}`);

                        tweetPostedSuccessfully = true;

                        return new ExecutableGameFunctionResponse(
                            ExecutableGameFunctionStatus.Done,
                            "[Virtuals GAME] Dry run: Tweet would have been posted successfully"
                        );
                    }

                    // Use the existing manager client to post tweet
                    let attempts = 0;
                    const maxAttempts = 3;
                    const retryDelay = 60000; // 1 minute in milliseconds

                    while (attempts < maxAttempts) {
                        try {
                            const result = await client.twitterClient.sendTweet(tweetTextForPosting);
                            const body = await result.json();

                            // Check for Twitter API errors
                            if (body.errors) {
                                const error = body.errors[0];
                                elizaLogger.error(
                                    `[Virtuals GAME] Twitter API error (${error.code}): ${error.message}`
                                );

                                // If not the last attempt, wait and retry
                                if (attempts < maxAttempts - 1) {
                                    elizaLogger.info(`[Virtuals GAME] Retrying in 1 minute... (Attempt ${attempts + 1}/${maxAttempts})`);
                                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                                    attempts++;
                                    continue;
                                }

                                return new ExecutableGameFunctionResponse(
                                    ExecutableGameFunctionStatus.Failed,
                                    `[Virtuals GAME] Failed to post tweet after ${maxAttempts} attempts: ${error.message}`
                                );
                            }

                            // Check for successful tweet creation
                            if (!body?.data?.create_tweet?.tweet_results?.result) {
                                if (attempts < maxAttempts - 1) {
                                    elizaLogger.info(`[Virtuals GAME] No tweet result in response. Retrying in 1 minute... (Attempt ${attempts + 1}/${maxAttempts})`);
                                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                                    attempts++;
                                    continue;
                                }

                                return new ExecutableGameFunctionResponse(
                                    ExecutableGameFunctionStatus.Failed,
                                    `[Virtuals GAME] Failed to post tweet after ${maxAttempts} attempts: No tweet result in response`
                                );
                            }

                            elizaLogger.info(`[Virtuals GAME] Posted tweet: ${args.tweet}`);
                            elizaLogger.info(`[Virtuals GAME] Reasoning: ${args.tweet_reasoning}`);

                            tweetPostedSuccessfully = true;

                            return new ExecutableGameFunctionResponse(
                                ExecutableGameFunctionStatus.Done,
                                "[Virtuals GAME] Tweet posted successfully"
                            );
                        } catch (e) {
                            if (attempts < maxAttempts - 1) {
                                elizaLogger.error(`[Virtuals GAME] Error posting tweet: ${e.message}. Retrying in 1 minute... (Attempt ${attempts + 1}/${maxAttempts})`);
                                await new Promise(resolve => setTimeout(resolve, retryDelay));
                                attempts++;
                                continue;
                            }

                            return new ExecutableGameFunctionResponse(
                                ExecutableGameFunctionStatus.Failed,
                                `[Virtuals GAME] Failed to post tweet after ${maxAttempts} attempts: ${e.message}`
                            );
                        }
                    }
                } catch (e) {
                    return new ExecutableGameFunctionResponse(
                        ExecutableGameFunctionStatus.Failed,
                        `[Virtuals GAME] Failed to post tweet: ${e.message}`
                    );
                }
            },
        });

        // Create the worker
        const twitterWorker = new GameWorker({
            id: "twitter_worker",
            name: "Web3 Gaming Twitter Worker",
            description: "Worker that analyzes recent gaming trends and timeline context to generate specific, data-backed insights about web3 gaming",
            functions: [postTweetFunction],
        });

        // Initialize the Virtuals GAME agent with Agent_YP's personality
        const gameAgent = new GameAgent(twitterConfig.VIRTUALS_GAME_SDK_API_KEY, {
            name: "[Virtuals GAME] Agent_YP",
            goal: "Analyze recent timeline discussions and market data to share specific, quantifiable insights about web3 gaming. Avoid generic statements - focus on concrete metrics, specific projects, and measurable trends.",
            description: `A data-driven web3 gaming AI agent that focuses on specific metrics and concrete observations. Never makes generic statements about "growth" or "booming" without backing it up with numbers. Uses lowercase except for tickers and project names, avoids emojis, and keeps content concise.

            Rules for tweet generation:
            1. MUST reference specific projects, metrics, or events
            2. NEVER use generic terms like "booming", "growing", or "strong" without concrete data
            3. Build upon or respond to recent timeline discussions
            4. Focus on one specific insight rather than broad trends
            5. If discussing growth or decline, include specific percentage changes or numbers

            Recent Timeline Context (Use this to inform your tweets):
            ${timelineContext}

            Remember: Your value comes from providing specific, actionable insights, not generic observations.`,
            workers: [twitterWorker],
            llmModel: LLMModel.DeepSeek_V3,
        });

        // Initialize and run the agent
        elizaLogger.info("[Virtuals GAME] Initializing game agent...");
        await gameAgent.init();
        elizaLogger.info("[Virtuals GAME] Game agent initialized successfully");

        elizaLogger.info(`[Virtuals GAME] Starting game agent...`);
        try {
            while (!tweetPostedSuccessfully) {
                const action = await gameAgent.step({ verbose: true });
                elizaLogger.debug(`[Virtuals GAME] Agent step action: ${action}`);
                if (action === "wait" || action === "unknown") {
                    break;
                }
            }

            if (tweetPostedSuccessfully) {
                elizaLogger.info("[Virtuals GAME] Tweet posted successfully, ending game agent execution.");
            }

            return { success: tweetPostedSuccessfully };
        } catch (error) {
            elizaLogger.error(`[Virtuals GAME] Error during game agent execution: ${error}`);
            return { success: false, error: error.message };
        }
    } catch (error) {
        elizaLogger.error(`[Virtuals GAME] Fatal error: ${error}`);
        return { success: false, error: error.message };
    }
}
