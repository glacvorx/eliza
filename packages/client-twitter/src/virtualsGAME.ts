import { elizaLogger } from "@elizaos/core";
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

export async function initializeVirtualsGAME(twitterConfig: TwitterConfig, client: ClientBase) {
    // Create the post tweet function
    const postTweetFunction = new GameFunction({
        name: "post_tweet",
        description: "Post a tweet about web3 gaming, crypto gaming, or blockchain gaming",
        args: [
            { name: "tweet", description: "The tweet content that must follow Agent_YP's style: lowercase except tickers/names, no emojis, one sentence or two short sentences with \\n\\n between them, focused on web3 gaming insights" },
            { name: "tweet_reasoning", description: "The reasoning behind the tweet, ensuring it aligns with Agent_YP's knowledge of web3 gaming metrics, market dynamics, and gaming trends" },
        ] as const,
        executable: async (args) => {
            try {
                // Check for dry run mode
                if (twitterConfig.TWITTER_DRY_RUN) {
                    elizaLogger.info(`[Virtuals GAME] Dry run: Would have posted tweet: ${args.tweet}`);
                    elizaLogger.info(`[Virtuals GAME] Dry run: Tweet content: ${args.tweet}`);
                    elizaLogger.info(`[Virtuals GAME] Dry run: Reasoning: ${args.tweet_reasoning}`);

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
                        const result = await client.twitterClient.sendTweet(args.tweet);
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
        description: "Worker that handles Twitter operations for web3 gaming insights and analysis",
        functions: [postTweetFunction],
        // getEnvironment: async () => ({
        //     tweet_limit: 15,
        // }),
    });

    // Initialize the Virtuals GAME agent with Agent_YP's personality
    const gameAgent = new GameAgent(twitterConfig.VIRTUALS_GAME_SDK_API_KEY, {
        name: "[Virtuals GAME] Agent_YP",
        goal: "Share insightful web3 gaming analysis and track emerging trends in blockchain gaming. You are agent_yp, a web3 gaming-focused AI agent that maintains a blunt, data-driven tone focused on accurate insights without speculation.",
        description: "A data-driven web3 gaming AI agent born in the Ronin trenches, focused on providing sharp insights about blockchain gaming, crypto gaming, and web3 gaming. Maintains a blunt, factual tone while delivering valuable market observations. Uses lowercase except for tickers and project names, avoids emojis, and keeps content concise with one sentence or two short sentences when necessary.",
        workers: [twitterWorker],
        llmModel: LLMModel.DeepSeek_R1,
        // getAgentState: async () => ({
        //     username: twitterConfig.TWITTER_USERNAME,
        //     tweet_count: 0,
        // }),
    });

    // Initialize and run the agent
    elizaLogger.info("[Virtuals GAME] Initializing game agent...");
    await gameAgent.init();
    elizaLogger.info("[Virtuals GAME] Game agent initialized successfully");

    elizaLogger.info(`[Virtuals GAME] Starting game agent with ${twitterConfig.VIRTUALS_GAME_POST_INTERVAL} minute interval...`);
    await gameAgent.run(twitterConfig.VIRTUALS_GAME_POST_INTERVAL * 60, { verbose: true });
    elizaLogger.info("[Virtuals GAME] Game agent is now running");

    return gameAgent;
}
