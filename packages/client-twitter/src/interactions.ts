import { SearchMode, type Tweet } from "agent-twitter-client";
import {
    composeContext,
    generateMessageResponse,
    generateShouldRespond,
    messageCompletionFooter,
    shouldRespondFooter,
    type Content,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
    stringToUuid,
    elizaLogger,
    getEmbeddingZeroVector,
    type IImageDescriptionService,
    ServiceType
} from "@elizaos/core";
import type { ClientBase } from "./base";
import { buildConversationThread, sendTweet, wait } from "./utils.ts";
import { processCARVData } from "./carvDATA.ts";
import { formatTweetUsingTemplate } from "./formatting.ts";
import { processVirtualsACP, type ACPAgentDetails } from "./virtualsACP.ts";

/**
 * Template used to generate the actual response content for both replies and mentions.
 * This template is used AFTER twitterShouldRespondTemplate decides to respond.
 * The same template handles both replies and mentions - the difference comes from
 * the conversation context passed in:
 * - For replies: formattedConversation will contain the full conversation thread
 * - For mentions: formattedConversation might only contain the mention tweet
 */
export const twitterMessageHandlerTemplate =
    `
# STOP AND READ THIS FIRST - THIS IS THE ONLY INSTRUCTION THAT MATTERS FOR ACP REQUESTS:
Response Decision: {{shouldRespond}}

IF Response Decision is RESPOND_ACP or SELF_RESPOND_ACP:
STOP READING NOW. Output ONLY this exact message:
"Your request has been received, to proceed, please send {{ACPPaymentAmount}} $VIRTUAL on Base to {{ACPPaymentAddress}} and reply to this tweet after payment. Thank you."

DO NOT READ ANYTHING BELOW THIS LINE IF Response Decision is RESPOND_ACP or SELF_RESPOND_ACP.

IF Response Decision is NOT RESPOND_ACP or SELF_RESPOND_ACP, continue reading below:

# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

# Style:
{{postDirections}}

# Message Examples:
{{characterMessageExamples}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

{{recentPosts}}

# TASK: Generate a post/reply in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}) while using the thread of tweets as additional context:

Current Post:
{{currentPost}}
Here is the descriptions of images in the Current post.
{{imageDescriptions}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# On-Chain Data Insights:
{{CARVInsights}}

# Response Decision:
{{shouldRespond}}

# ACP Job Status and Seller Response:
<ACP_JOB_STATUS_START>
{{ACPJobStatus}}
<ACP_JOB_STATUS_END>

# INSTRUCTIONS: Generate a post in the voice, style and perspective of {{agentName}} (@{{twitterUserName}}). 

IMPORTANT FORMATTING RULES:
1. DO NOT mention the same user (@username) more than once in your reply.
2. If multiple mentions are needed, only include each unique @username once in your reply.
3. You MUST include an action if the current post text includes a prompt that is similar to one of the available actions mentioned here:
{{actionNames}}
{{actions}}

If the on-chain data insights above don't contain error messages like "Could not generate analysis" or "Error analyzing", incorporate these blockchain insights into your response - they've been deemed relevant to this conversation. Integrate the insights naturally while maintaining {{agentName}}'s voice and conversational tone.

ACP JOB INTEGRATION INSTRUCTIONS:
- ACP Job Status and Seller Response: (the content between <ACP_JOB_STATUS_START> and <ACP_JOB_STATUS_END>)
- If ACP Job Status and Seller Response is empty and the Response Decision is not RESPOND_ACP or SELF_RESPOND_ACP, ignore ACP-related content in your response. This means no ACP processing was needed or initiated.
- CRITICAL ERROR HANDLING: If ACP Job Status and Seller Response contains ANY error messages (including but not limited to "Error:", "Failed:", "No suitable agents found", "No offerings available", "Schema validation failed", "Job failed", "Job monitoring timeout", "Error processing ACP job:", "Error processing payment confirmation:", "Error creating ACP client", "Error searching for agents", "Agent not found", "No offerings available for agent", "Error initiating ACP job", "Failed to retrieve agent or initiate job", "No agent details found", or any other error indicators), completely ignore ACP-related content in your response and do not mention ACP at all. Respond as if ACP was never mentioned. DO NOT acknowledge payment, DO NOT mention job completion, DO NOT reference any ACP-related information.
- If the Response Decision is RESPOND_PAYMENT_CONFIRMED and ACP Job Status and Seller Response contains a seller response (look for "Seller Response:" in the text), incorporate that response naturally into your reply. PRESERVE ALL DETAILS, STATISTICS, AND ANALYSIS from the seller response - do not summarize or condense the information. The seller response contains valuable work results that should be shared with the user in full detail. DO NOT add phrases like "job completed successfully" or any other job completion language - simply present the seller response content directly.
- CRITICAL: When seller responses contain multiple tokens/items, you MUST include ALL tokens/items mentioned in the response. Do not pick and choose - include every single one with their key details.
- For each token/item in the seller response, include: token name/ticker, score, key rationale, and most relevant summary points. Do not omit any tokens from the response.
- If the seller response contains detailed JSON data with multiple entries, parse and include ALL entries with their respective details (scores, rationales, summaries, etc.).
- If the Response Decision is RESPOND_PAYMENT_CONFIRMED and ACP Job Status and Seller Response indicates a job was completed with a success response (look for "Payment received! Job completed successfully" or "Job completed successfully"), DO NOT mention job completion or success. Simply present the seller response content directly without any acknowledgment of job completion.
- PAYMENT FAILURE HANDLING: If the Response Decision is RESPOND_PAYMENT_CONFIRMED and ACP Job Status and Seller Response contains payment failure messages (look for "Payment not received" or "Please send [amount] $VIRTUAL on Base to [address] and reply to this tweet again"), you MUST respond with ONLY the following exact format:
"Apologies, the payment was not received. Please send the tokens on Base and reply to this tweet once you've sent it. Thank you!"
- Always maintain {{agentName}}'s voice and style when incorporating ACP information.
- Remember that ACP jobs will always have a response - either initial payment instructions, seller response data, success confirmation, payment failure messages, or empty string (no ACP processing). The response will be available in the ACP Job Status and Seller Response field.
- When incorporating seller responses, maintain the agent's conversational tone while preserving all technical details, metrics, and analysis provided by the seller.

Here is the current post text again. Remember to include an action if the current post text includes a prompt that asks for one of the available actions mentioned above (does not need to be exact)
{{currentPost}}
Here is the descriptions of images in the Current post.
{{imageDescriptions}}

FINAL REMINDER: If ACP Job Status and Seller Response contains ANY error message (starts with "Error:" or contains "Failed:", "No agent details found", etc.), completely ignore all ACP-related content and respond as if the user just sent a normal message without any ACP context.

# CRITICAL INSTRUCTIONS:
- If the Response Decision is RESPOND_PAYMENT_CONFIRMED and ACP Job Status and Seller Response is present, output ONLY the content between <ACP_JOB_STATUS_START> and <ACP_JOB_STATUS_END> as your response.
- Do not summarize, rewrite, or add anything.
- Format the information to remove symbols used for formatting (one example includes repeated "-"), but keep paragraphs
- Replace double line breaks (\n\n) with a single line break.
- Remove sign offs mentioning "Arbus".

# ACP FINAL CHECK:
If Response Decision is RESPOND_ACP or SELF_RESPOND_ACP, output ONLY the ACP payment message from the top of this template.
` + messageCompletionFooter;

/**
 * Template used to decide WHETHER to respond to any Twitter interaction (both replies and mentions).
 * This is called BEFORE twitterMessageHandlerTemplate and returns either:
 * - RESPOND: Generate a response using twitterMessageHandlerTemplate
 * - IGNORE: Skip this interaction
 * - STOP: Stop participating in this conversation
 * 
 * The same template is used for both replies and mentions, with the decision based on:
 * - Priority users (always respond)
 * - Message relevance
 * - Conversation context
 * - Direct addressing
 * @param targetUsersStr Comma-separated list of priority Twitter usernames to always respond to
 * 
 * Temporarily disabled CARV/Onchain data considerations
BLOCKCHAIN/ONCHAIN DATA CONSIDERATIONS:
- {{agentName}} should RESPOND to questions about onchain data or blockchain analytics
- {{agentName}} should RESPOND when the tweet mentions specific blockchain addresses, transactions, or tokens
- {{agentName}} should RESPOND to questions about on-chain activity, wallet balances, or transaction history
- {{agentName}} should RESPOND to discussions about blockchain trends where on-chain data analysis would be valuable
- {{agentName}} should RESPOND when a tweet references a specific Twitter user whose on-chain activities could be relevant
- {{agentName}} should RESPOND to mentions of Ethereum, Bitcoin, Solana, or other blockchain data that could be queried
- {{agentName}} may still IGNORE general crypto discussions without specific on-chain data needs
- {{agentName}} may still IGNORE non-technical topics where blockchain data adds little value
 */
export const twitterShouldRespondTemplate = (targetUsersStr: string) =>
    `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation. Do not comment. Just respond with one of the following options:

- [RESPOND]: Respond to the tweet as usual.
- [RESPOND_ACP]: Respond to the tweet and indicate that an ACP (Agent Commerce Protocol) service is required for the next step (i.e., the tweet requests a service/information or content that can be accomplished by the ACP agent network).
- [SELF_RESPOND_ACP]: Respond to the tweet and indicate that a blockchain/web3 gaming related content generation request requires an ACP service (separate flow from regular ACP requests).
- [RESPOND_PAYMENT_CONFIRMED]: Respond to the tweet indicating that the user has confirmed payment has been made for a previous ACP request.
- [IGNORE]: Skip this interaction.
- [STOP]: Stop participating in this conversation.

PRIORITY RULE: ALWAYS RESPOND to these users regardless of topic or message content: ${targetUsersStr}. Topic relevance should be ignored for these users.

For other users:
- {{agentName}} should RESPOND to messages directed at them
- {{agentName}} should RESPOND to conversations relevant to their background
- {{agentName}} should IGNORE irrelevant messages
- {{agentName}} should IGNORE very short messages unless directly addressed
- {{agentName}} should STOP if asked to stop
- {{agentName}} should STOP if conversation is concluded
- {{agentName}} is in a room with other users and wants to be conversational, but not annoying.

# ACP SERVICE DETECTION:
If the tweet requests a service, information, or content that can be accomplished by the network of agents in the ACP (Agent Commerce Protocol) network, respond with [RESPOND_ACP].

# BLOCKCHAIN/WEB3 GAMING CONTENT GENERATION DETECTION:
If the tweet requests blockchain/web3 gaming related content generation that can be accomplished by the ACP network, respond with [SELF_RESPOND_ACP]. This includes but is not limited to:
- Web3 gaming market analysis and reports
- Blockchain gaming trend summaries
- NFT gaming ecosystem research
- DeFi gaming protocol analysis
- Metaverse gaming content generation
- Blockchain gaming newsletter creation
- Web3 gaming alpha/insights generation
- Gaming token analysis and reports
- Play-to-earn gaming research
- Blockchain gaming industry summaries

The ACP network offers a wide variety of services, including but not limited to:
- Authenticate NFT on Story Protocol
- Smart contract analysis
- Get market alpha/insights/reports/analysis
- Trading signal validation
- Creating cinematic videos
- Creating and training community manager agents
- Smart contract audit
- Token audit
- Song generation
- Content generation (including newsletters, reports, summaries, research, and similar requests)
- Automated research and information gathering
- Generating newsletters or summaries of news/events (e.g., "Could you create a newsletter for me, covering the top 3 news on web3 gaming that happened on July?")

If the tweet requests blockchain/web3 gaming related content generation services, respond with [SELF_RESPOND_ACP].
If the tweet requests any other services, information, or content that could be fulfilled by an agent in the ACP network, respond with [RESPOND_ACP].

If the tweet does not request such a service, but should otherwise be responded to, respond with [RESPOND].

# ACP PAYMENT CONFIRMATION DETECTION:
If this tweet appears to be a reply to a previous ACP payment request and contains payment confirmation language, respond with [RESPOND_PAYMENT_CONFIRMED]. Look for phrases like:
- "sent", "paid", "payment sent", "done", "completed", "finished", "submitted", "transferred"
- "sent the payment", "paid the fee", "sent the virtuals", "payment done", "transaction sent"
- "i sent it", "payment completed", "transaction done", "money sent", "fee paid"
- Any confirmation that payment has been made

The tweet must be replying to a tweet that contains ACP payment instructions (look for mentions of $VIRTUAL, Base chain, or payment addresses) to qualify as a payment confirmation.

Recent Posts:
{{recentPosts}}

Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Respond with [SELF_RESPOND_ACP] if the tweet requests blockchain/web3 gaming related content generation that can be accomplished by the ACP agent network, [RESPOND_ACP] if the tweet requests any other service/information/content that can be accomplished by the ACP agent network, [RESPOND_PAYMENT_CONFIRMED] if the user has confirmed payment for a previous ACP request, [RESPOND] if a normal response is appropriate, [IGNORE] if no response is needed, or [STOP] if participation should end.
`;

export class TwitterInteractionClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    private isDryRun: boolean;
    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
        this.isDryRun = this.client.twitterConfig.TWITTER_DRY_RUN;
    }

    async start() {
        const handleTwitterInteractionsLoop = () => {
            this.handleTwitterInteractions();
            setTimeout(
                handleTwitterInteractionsLoop,
                // Defaults to 2 minutes
                this.client.twitterConfig.TWITTER_POLL_INTERVAL * 1000
            );
        };
        handleTwitterInteractionsLoop();
    }

    async handleTwitterInteractions() {
        elizaLogger.log("Checking Twitter interactions");

        const twitterUsername = this.client.profile.username;
        try {
            // Check for mentions
            const mentionCandidates = (
                await this.client.fetchSearchTweets(
                    `@${twitterUsername}`,
                    20,
                    SearchMode.Latest
                )
            ).tweets;

            elizaLogger.log(
                "Completed checking mentioned tweets:",
                mentionCandidates.length
            );
            let uniqueTweetCandidates = [...mentionCandidates];
            // Only process target users if configured
            if (this.client.twitterConfig.TWITTER_TARGET_USERS.length) {
                const TARGET_USERS =
                    this.client.twitterConfig.TWITTER_TARGET_USERS;

                elizaLogger.log("Processing target users:", TARGET_USERS);

                if (TARGET_USERS.length > 0) {
                    // Create a map to store tweets by user
                    const tweetsByUser = new Map<string, Tweet[]>();

                    // Fetch tweets from all target users
                    for (const username of TARGET_USERS) {
                        try {
                            const userTweets = (
                                await this.client.twitterClient.fetchSearchTweets(
                                    `from:${username}`,
                                    3,
                                    SearchMode.Latest
                                )
                            ).tweets;

                            // Filter for unprocessed, non-reply, recent tweets
                            const validTweets = userTweets.filter((tweet) => {
                                const isUnprocessed =
                                    !this.client.lastCheckedTweetId ||
                                    Number.parseInt(tweet.id) >
                                        this.client.lastCheckedTweetId;
                                const isRecent =
                                    Date.now() - tweet.timestamp * 1000 <
                                    2 * 60 * 60 * 1000;

                                elizaLogger.log(`Tweet ${tweet.id} checks:`, {
                                    isUnprocessed,
                                    isRecent,
                                    isReply: tweet.isReply,
                                    isRetweet: tweet.isRetweet,
                                });

                                return (
                                    isUnprocessed &&
                                    !tweet.isReply &&
                                    !tweet.isRetweet &&
                                    isRecent
                                );
                            });

                            if (validTweets.length > 0) {
                                tweetsByUser.set(username, validTweets);
                                elizaLogger.log(
                                    `Found ${validTweets.length} valid tweets from ${username}`
                                );
                            }
                        } catch (error) {
                            elizaLogger.error(
                                `Error fetching tweets for ${username}:`,
                                error
                            );
                            continue;
                        }
                    }

                    // Select one tweet from each user that has tweets
                    const selectedTweets: Tweet[] = [];
                    for (const [username, tweets] of tweetsByUser) {
                        if (tweets.length > 0) {
                            // Randomly select one tweet from this user
                            const randomTweet =
                                tweets[
                                    Math.floor(Math.random() * tweets.length)
                                ];
                            selectedTweets.push(randomTweet);
                            elizaLogger.log(
                                `Selected tweet from ${username}: ${randomTweet.text?.substring(0, 100)}`
                            );
                        }
                    }

                    // Add selected tweets to candidates
                    uniqueTweetCandidates = [
                        ...mentionCandidates,
                        ...selectedTweets,
                    ];
                }
            } else {
                elizaLogger.log(
                    "No target users configured, processing only mentions"
                );
            }

            // Sort tweet candidates by ID in ascending order
            uniqueTweetCandidates
                .sort((a, b) => a.id.localeCompare(b.id))
                .filter((tweet) => tweet.userId !== this.client.profile.id);

            // for each tweet candidate, handle the tweet
            for (const tweet of uniqueTweetCandidates) {
                if (
                    !this.client.lastCheckedTweetId ||
                    BigInt(tweet.id) > this.client.lastCheckedTweetId
                ) {
                    // Generate the tweetId UUID the same way it's done in handleTweet
                    const tweetId = stringToUuid(
                        tweet.id + "-" + this.runtime.agentId
                    );

                    // Check if we've already processed this tweet
                    const existingResponse =
                        await this.runtime.messageManager.getMemoryById(
                            tweetId
                        );

                    if (existingResponse) {
                        elizaLogger.log(
                            `Already responded to tweet ${tweet.id}, skipping`
                        );
                        continue;
                    }
                    elizaLogger.log("New Tweet found", tweet.permanentUrl);

                    const roomId = stringToUuid(
                        tweet.conversationId + "-" + this.runtime.agentId
                    );

                    const userIdUUID =
                        tweet.userId === this.client.profile.id
                            ? this.runtime.agentId
                            : stringToUuid(tweet.userId!);

                    await this.runtime.ensureConnection(
                        userIdUUID,
                        roomId,
                        tweet.username,
                        tweet.name,
                        "twitter"
                    );

                    const thread = await buildConversationThread(
                        tweet,
                        this.client
                    );

                    const message = {
                        content: { 
                            text: tweet.text,
                            imageUrls: tweet.photos?.map(photo => photo.url) || []
                        },
                        agentId: this.runtime.agentId,
                        userId: userIdUUID,
                        roomId,
                    };

                    await this.handleTweet({
                        tweet,
                        message,
                        thread,
                    });

                    // Update the last checked tweet ID after processing each tweet
                    this.client.lastCheckedTweetId = BigInt(tweet.id);
                }
            }

            // Save the latest checked tweet ID to the file
            await this.client.cacheLatestCheckedTweetId();

            elizaLogger.log("Finished checking Twitter interactions");
        } catch (error) {
            elizaLogger.error("Error handling Twitter interactions:", error);
        }
    }

    private async handleTweet({
        tweet,
        message,
        thread,
    }: {
        tweet: Tweet;
        message: Memory;
        thread: Tweet[];
    }) {
        // Only skip if tweet is from self AND not from a target user
        if (tweet.userId === this.client.profile.id &&
            !this.client.twitterConfig.TWITTER_TARGET_USERS.includes(tweet.username)) {
            return;
        }

        if (!message.content.text) {
            elizaLogger.log("Skipping Tweet with no text", tweet.id);
            return { text: "", action: "IGNORE" };
        }

        elizaLogger.log("Processing Tweet: ", tweet.id);
        const formatTweet = (tweet: Tweet) => {
            return `  ID: ${tweet.id}
  From: ${tweet.name} (@${tweet.username})
  Text: ${tweet.text}`;
        };
        const currentPost = formatTweet(tweet);

        const formattedConversation = thread
            .map(
                (tweet) => `@${tweet.username} (${new Date(
                    tweet.timestamp * 1000
                ).toLocaleString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                    month: "short",
                    day: "numeric",
                })}):
        ${tweet.text}`
            )
            .join("\n\n");

        const imageDescriptionsArray = [];
        try{
            for (const photo of tweet.photos) {
                const description = await this.runtime
                    .getService<IImageDescriptionService>(
                        ServiceType.IMAGE_DESCRIPTION
                    )
                    .describeImage(photo.url);
                imageDescriptionsArray.push(description);
            }
        } catch (error) {
    // Handle the error
    elizaLogger.error("Error Occured during describing image: ", error);
}

        // Format image descriptions
        const formattedImageDescriptions = imageDescriptionsArray.length > 0
            ? `\nImages in Tweet:\n${imageDescriptionsArray.map((desc, i) =>
                `Image ${i + 1}: ${desc.title ? `Title: ${desc.title}\n` : ''}Description: ${desc.description || 'No description'}`).join("\n\n")}`
            : "";

        // Extract quoted content if available
        const quotedContent = tweet.quotedStatus ? tweet.quotedStatus.text || "" : "";

        let state = await this.runtime.composeState(message, {
            twitterClient: this.client.twitterClient,
            twitterUserName: this.client.twitterConfig.TWITTER_USERNAME,
            currentPost,
            formattedConversation,
            imageDescriptions: formattedImageDescriptions,
            quotedContent,
        });

        // check if the tweet exists, save if it doesn't
        const tweetId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
        const tweetExists =
            await this.runtime.messageManager.getMemoryById(tweetId);

        if (!tweetExists) {
            elizaLogger.log("tweet does not exist, saving");
            const userIdUUID = stringToUuid(tweet.userId as string);
            const roomId = stringToUuid(tweet.conversationId);

            const message = {
                id: tweetId,
                agentId: this.runtime.agentId,
                content: {
                    text: tweet.text,
                    url: tweet.permanentUrl,
                    imageUrls: tweet.photos?.map(photo => photo.url) || [],
                    inReplyTo: tweet.inReplyToStatusId
                        ? stringToUuid(
                              tweet.inReplyToStatusId +
                                  "-" +
                                  this.runtime.agentId
                          )
                        : undefined,
                },
                userId: userIdUUID,
                roomId,
                createdAt: tweet.timestamp * 1000,
            };
            this.client.saveRequestMessage(message, state);
        }

        // get usernames into str
        const validTargetUsersStr =
            this.client.twitterConfig.TWITTER_TARGET_USERS.join(",");

        const shouldRespondContext = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.twitterShouldRespondTemplate ||
                this.runtime.character?.templates?.shouldRespondTemplate ||
                twitterShouldRespondTemplate(validTargetUsersStr),
        });

        const shouldRespond = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.MEDIUM,
        });

        // Promise<"RESPOND" | "IGNORE" | "STOP" | null> {
        if (shouldRespond !== "RESPOND" && shouldRespond !== "RESPOND_ACP" && shouldRespond !== "SELF_RESPOND_ACP" && shouldRespond !== "RESPOND_PAYMENT_CONFIRMED") {
            elizaLogger.log("Not responding to message");
            return { text: "Response Decision:", action: shouldRespond };
        }

        let CARVInsights = "";
        if (this.client.twitterConfig.ENABLE_CARV_DATA) {
            try {
                elizaLogger.log("[CARV] Processing on-chain data for tweet since agent will respond");

                CARVInsights = await processCARVData(
                    this.runtime,
                    this.client.twitterConfig.TWITTER_USERNAME,
                    tweet,
                    formattedConversation,
                    imageDescriptionsArray.map(desc => desc.description || "No description"),
                    quotedContent
                );

                if (CARVInsights) {
                    elizaLogger.log("[CARV] Added on-chain insights to response context");
                }
            } catch (error) {
                elizaLogger.error("[CARV] Error fetching on-chain data:", error);
                CARVInsights = "";
            }
        }

        let ACPJobStatus = "";
        let ACPPaymentAmount = 0;
        if (this.client.twitterConfig.ENABLE_VIRTUALS_ACP && (shouldRespond === "RESPOND_ACP" || shouldRespond === "SELF_RESPOND_ACP" || shouldRespond === "RESPOND_PAYMENT_CONFIRMED")) {
            elizaLogger.debug(`[Virtuals ACP] Tweet: ${tweet.text} shouldRespond: ${shouldRespond}`);

            const acpResult = await processVirtualsACP(
                this.runtime,
                this.client.twitterConfig.TWITTER_USERNAME,
                tweet,
                formattedConversation,
                imageDescriptionsArray.map(desc => desc.description || "No description"),
                quotedContent,
                this.client.twitterConfig,
                shouldRespond
            );
            ACPJobStatus = acpResult.sellerResponse;
            ACPPaymentAmount = acpResult.ACPPaymentAmount;
        }

        const context = composeContext({
            state: {
                ...state,
                // Add CARV insights to the context
                CARVInsights: CARVInsights,
                // Add the response decision to the context
                shouldRespond: shouldRespond,
                // Add the ACP buyer agent wallet address to the context
                ACPPaymentAddress: this.client.twitterConfig.VIRTUALS_ACP_BUYER_WALLET_ADDRESS,
                ACPPaymentAmount: ACPPaymentAmount,
                // Add ACP seller response to the context (includes job status and any seller response)
                ACPJobStatus: ACPJobStatus,
                // Convert actionNames array to string
                actionNames: Array.isArray(state.actionNames)
                    ? state.actionNames.join(', ')
                    : state.actionNames || '',
                actions: Array.isArray(state.actions)
                    ? state.actions.join('\n')
                    : state.actions || '',
                // Ensure character examples are included
                characterPostExamples: this.runtime.character.messageExamples
                    ? this.runtime.character.messageExamples
                        .map(example =>
                            example.map(msg =>
                                `${msg.user}: ${msg.content.text}${msg.content.action ? ` [Action: ${msg.content.action}]` : ''}`
                            ).join('\n')
                        ).join('\n\n')
                    : '',
            },
            template:
                this.runtime.character.templates
                    ?.twitterMessageHandlerTemplate ||
                this.runtime.character?.templates?.messageHandlerTemplate ||
                twitterMessageHandlerTemplate,
        });

        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        if (this.client.twitterConfig.ENABLE_TWEET_FORMATTING) {
            response.text = await formatTweetUsingTemplate(
                this.runtime,
                response.text
            );
        }

        const removeQuotes = (str: string) =>
            str.replace(/^['"](.*)['"]$/, "$1");

        const stringId = stringToUuid(tweet.id + "-" + this.runtime.agentId);

        response.inReplyTo = stringId;

        response.text = removeQuotes(response.text);

        if (response.text) {
            if (this.isDryRun) {
                elizaLogger.info(
                    `Dry run: Selected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`
                );
            } else {
                try {
                    const callback: HandlerCallback = async (
                        response: Content,
                        tweetId?: string
                    ) => {
                        const memories = await sendTweet(
                            this.client,
                            response,
                            message.roomId,
                            this.client.twitterConfig.TWITTER_USERNAME,
                            tweetId || tweet.id
                        );
                        return memories;
                    };

                    const action = this.runtime.actions.find((a) => a.name === response.action);
                    const shouldSuppressInitialMessage = action?.suppressInitialMessage;

                    let responseMessages = [];

                    if (!shouldSuppressInitialMessage) {
                        responseMessages = await callback(response);
                    } else {
                        responseMessages = [{
                            id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                            userId: this.runtime.agentId,
                            agentId: this.runtime.agentId,
                            content: response,
                            roomId: message.roomId,
                            embedding: getEmbeddingZeroVector(),
                            createdAt: Date.now(),
                        }];
                    }

                    state = (await this.runtime.updateRecentMessageState(
                        state
                    )) as State;

                    for (const responseMessage of responseMessages) {
                        if (
                            responseMessage ===
                            responseMessages[responseMessages.length - 1]
                        ) {
                            responseMessage.content.action = response.action;
                        } else {
                            responseMessage.content.action = "CONTINUE";
                        }
                        await this.runtime.messageManager.createMemory(
                            responseMessage
                        );
                    }

                    const responseTweetId =
                    responseMessages[responseMessages.length - 1]?.content
                        ?.tweetId;

                    await this.runtime.processActions(
                        message,
                        responseMessages,
                        state,
                        (response: Content) => {
                            return callback(response, responseTweetId);
                        }
                    );

                    const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`;

                    await this.runtime.cacheManager.set(
                        `twitter/tweet_generation_${tweet.id}.txt`,
                        responseInfo
                    );

                    await wait();
                } catch (error) {
                    elizaLogger.error(`Error sending response tweet: ${error}`);
                }
            }
        }
    }

    async buildConversationThread(
        tweet: Tweet,
        maxReplies = 10
    ): Promise<Tweet[]> {
        const thread: Tweet[] = [];
        const visited: Set<string> = new Set();

        async function processThread(currentTweet: Tweet, depth = 0) {
            elizaLogger.log("Processing tweet:", {
                id: currentTweet.id,
                inReplyToStatusId: currentTweet.inReplyToStatusId,
                depth: depth,
            });

            if (!currentTweet) {
                elizaLogger.log("No current tweet found for thread building");
                return;
            }

            if (depth >= maxReplies) {
                elizaLogger.log("Reached maximum reply depth", depth);
                return;
            }

            // Handle memory storage
            const memory = await this.runtime.messageManager.getMemoryById(
                stringToUuid(currentTweet.id + "-" + this.runtime.agentId)
            );
            if (!memory) {
                const roomId = stringToUuid(
                    currentTweet.conversationId + "-" + this.runtime.agentId
                );
                const userId = stringToUuid(currentTweet.userId);

                await this.runtime.ensureConnection(
                    userId,
                    roomId,
                    currentTweet.username,
                    currentTweet.name,
                    "twitter"
                );

                this.runtime.messageManager.createMemory({
                    id: stringToUuid(
                        currentTweet.id + "-" + this.runtime.agentId
                    ),
                    agentId: this.runtime.agentId,
                    content: {
                        text: currentTweet.text,
                        source: "twitter",
                        url: currentTweet.permanentUrl,
                        imageUrls: currentTweet.photos?.map(photo => photo.url) || [],
                        inReplyTo: currentTweet.inReplyToStatusId
                            ? stringToUuid(
                                  currentTweet.inReplyToStatusId +
                                      "-" +
                                      this.runtime.agentId
                              )
                            : undefined,
                    },
                    createdAt: currentTweet.timestamp * 1000,
                    roomId,
                    userId:
                        currentTweet.userId === this.twitterUserId
                            ? this.runtime.agentId
                            : stringToUuid(currentTweet.userId),
                    embedding: getEmbeddingZeroVector(),
                });
            }

            if (visited.has(currentTweet.id)) {
                elizaLogger.log("Already visited tweet:", currentTweet.id);
                return;
            }

            visited.add(currentTweet.id);
            thread.unshift(currentTweet);

            if (currentTweet.inReplyToStatusId) {
                elizaLogger.log(
                    "Fetching parent tweet:",
                    currentTweet.inReplyToStatusId
                );
                try {
                    const parentTweet = await this.twitterClient.getTweet(
                        currentTweet.inReplyToStatusId
                    );

                    if (parentTweet) {
                        elizaLogger.log("Found parent tweet:", {
                            id: parentTweet.id,
                            text: parentTweet.text?.slice(0, 50),
                        });
                        await processThread(parentTweet, depth + 1);
                    } else {
                        elizaLogger.log(
                            "No parent tweet found for:",
                            currentTweet.inReplyToStatusId
                        );
                    }
                } catch (error) {
                    elizaLogger.log("Error fetching parent tweet:", {
                        tweetId: currentTweet.inReplyToStatusId,
                        error,
                    });
                }
            } else {
                elizaLogger.log(
                    "Reached end of reply chain at:",
                    currentTweet.id
                );
            }
        }

        // Need to bind this context for the inner function
        await processThread.bind(this)(tweet, 0);

        return thread;
    }
}