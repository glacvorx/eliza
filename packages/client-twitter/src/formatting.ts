import {
    composeContext,
    elizaLogger,
    generateText,
    type IAgentRuntime,
    ModelClass,
    stringToUuid
} from "@elizaos/core";

/**
 * Template for determining if a tweet should be formatted according to predefined templates
 */
export const formatDecisionTemplate = `
# INSTRUCTIONS: Determine if the current tweet response should be formatted according to predefined templates.

Current Tweet Response:
{{currentPost}}

Available Format Templates:
- P2A Campaign:
[Project X] announced a P2A campaign with a total prize pool of [X $USDT] in their token.

- P2A Campaign 1st day update:
P2A campaign kicks off with [X] players joining on Day 1

- List of ongoing P2A Campaign
List of ongoing P2A to take note:
- [Project X] from [Start day - End date] with a prizepool of [X $USDT] in their token
- [Project Y] from [Start day - End date] with a prizepool of [Y $USDT] in their token
- [Project Z] from [Start day - End date] with a prizepool of [Z $USDT] in their token.

- NFT holdings:
[Project X] now has [X] total NFT holders, with [Y%] unique holders out of the total supply. The community continues to grow!

- Massive NFT Sweep:
A single wallet just swept [X] NFTs from [Project X] for a total of [X $ETH] (X $USDT)

- Mint announcement:
[Project X] has announced its mint date and price. The minting will start on [Date] with a [$token] mint price per NFT.

- Mint of the Project:
[Project X] NFT mint is now live. Supply: [X], Price: [X $ETH/X $TOKEN].

- Minted Out Announcement
[Project X] NFTs minted out in [X minutes/X seconds], generating [X ETH] (X $USDT).

- Staking
[Project X] has just announced staking, allowing you to earn [X%] APY /X Points on staked tokens. Start staking today to earn rewards!

- Eco growth
[Project X] is expanding its ecosystem by integrating with [New Chain/Platform]

- Tournaments:
[Project X] is launching a tournament with a [X $USDT] prize pool! The tournament will last for [X] days, starting at [Start Time] and ending at [End Time]. Register now for your chance to win!

- CEX listing (Binance, Bybit, Coinbase):
[CEX Name] has added support for [Project X] token, with trading starting on [Date] at [Time] UTC
[Project X] token will be listed on [CEX Name] on [Date] at [Time] UTC or later.

- Partnership announcement
[Project X] has announced a partnership with [Partner Name] to drive growth and bring new opportunities to the community.

- Token Price Increase:
[Project X] token $X pumped [X%] in the last [24 hours/1 hour], reaching [$X].

- NEW ATH
ATH Update: [Project X] token hit a new ATH, reaching [$X] after a [X%] pump.

- Daily Active Users
[Project X] hit [X] daily active users, marking a [X%] growth from last month/day/week

- Fundraising
[Project X] successfully raised [$X million] in its latest [Seed/Series A] round, backed by [Notable Investors].

- Game release
[Project X] is officially live. Players can now dive into [Game Name] and start playing.

- Beta test announcement
[Project X] beta is now live, with [X] testers granted early access to gameplay starting today.

- Beta ending
[Project X] has officially ended its beta test.

# INSTRUCTIONS:
1. Analyze if the current tweet response matches any of the predefined formats
2. If it matches, process the data to:
   - Convert dates to appropriate format (e.g., "2024-03-20" to "March 20")
   - Convert numbers to appropriate units (e.g., "1000000" to "1M")
   - Calculate percentages when possible
   - Format currency values consistently
   - Round large numbers appropriately
3. If some data in square brackets is missing but the tweet matches a template:
   - Format the tweet anyway, excluding the missing data
   - Keep the template structure but omit the missing parts
4. If it matches, respond with [FORMAT_TWEET] followed by the formatted text
5. If it doesn't match any format, respond with [SKIP_FORMAT]

Return ONLY the action tag and formatted text (if applicable) without any additional explanation.
`;

/**
 * Parse a response text to determine formatting actions
 */
export const parseFormatActionResponseFromText = (
    text: string
): { shouldFormat: boolean; formattedText?: string } => {
    const formatPattern = /\[FORMAT_TWEET\]\s*(.*)/i;
    const skipPattern = /\[SKIP_FORMAT\]/i;

    // Check for format action
    const formatMatch = text.match(formatPattern);
    if (formatMatch) {
        return {
            shouldFormat: true,
            formattedText: formatMatch[1].trim().replace(/^\[FORMAT_TWEET\]\s*/i, '')
        };
    }

    // Check for skip action
    if (skipPattern.test(text)) {
        return {
            shouldFormat: false
        };
    }

    // Default to not formatting if no clear action is found
    return {
        shouldFormat: false
    };
};

/**
 * Generate a formatting decision based on the tweet content
 */
export async function generateFormatDecision({
    runtime,
    context,
    modelClass,
}: {
    runtime: IAgentRuntime;
    context: string;
    modelClass: ModelClass;
}): Promise<{ shouldFormat: boolean; formattedText?: string } | null> {
    try {
        const response = await generateText({
            runtime,
            context,
            modelClass,
        });
        elizaLogger.debug(
            "[FORMAT TWEET] Received response from generateText for format decision:",
            response
        );
        const result = parseFormatActionResponseFromText(response.trim());
        if (result) {
            elizaLogger.debug("[FORMAT TWEET] Parsed format decision:", result);
            return result;
        } else {
            elizaLogger.debug("[FORMAT TWEET] generateFormatDecision no valid response");
            return null;
        }
    } catch (error) {
        elizaLogger.error("[FORMAT TWEET] Error in generateFormatDecision:", error);
        return null;
    }
}

/**
 * Determines whether a tweet should be formatted and returns the formatted text if applicable
 */
export async function formatTweetUsingTemplate(
    runtime: IAgentRuntime,
    tweetText: string,
): Promise<string> {
    try {
        // Create initial state for decision making
        const state = await runtime.composeState(
            {
                userId: runtime.agentId,
                roomId: stringToUuid("format-" + runtime.agentId),
                agentId: runtime.agentId,
                content: { text: tweetText, action: "" },
            },
            {
                currentPost: tweetText,
            }
        );

        // Create the decision context
        const formatDecisionContext = composeContext({
            state,
            template: formatDecisionTemplate,
        });

        // Get format decision using the specialized format decision generator
        const formatDecision = await generateFormatDecision({
            runtime: runtime,
            context: formatDecisionContext,
            modelClass: ModelClass.LARGE,
        });

        if (formatDecision?.shouldFormat && formatDecision.formattedText) {
            elizaLogger.log("[FORMAT TWEET] Decision: Tweet should be formatted");
            return formatDecision.formattedText;
        } else {
            elizaLogger.log("[FORMAT TWEET] Decision: Tweet should not be formatted");
            return tweetText;
        }
    } catch (error) {
        elizaLogger.error("[FORMAT TWEET] Error in tweet formatting process:", error);
        return tweetText; // Default to original text on error
    }
}
