import { elizaLogger, IAgentRuntime, stringToUuid, generateText, ModelClass, composeContext, getEmbeddingZeroVector } from "@elizaos/core";
import { TwitterConfig } from "./environment";
import { Address } from '@aa-sdk/core';
import { Tweet } from "agent-twitter-client";
import { parseUnits } from "viem";

/**
 * Template for determining ACP service usage and generating task details
 */
export const acpServiceTemplate =
    `
# INSTRUCTIONS: Determine if this tweet is asking for a task to be performed or information to be retrieved from the Agentic Network:

Tweet: {{currentPost}}

Context: ACP (Agent Commerce Protocol) connects to an Agentic Network where specialized AI agents can perform tasks or retrieve information on your behalf.

Analyze the tweet to determine if it contains:
1. TASK REQUESTS - Asking for something to be done, created, analyzed, or processed
2. INFORMATION REQUESTS - Asking for data, research, insights, or knowledge to be retrieved

Consider hiring an ACP agent when the tweet explicitly or implicitly asks for:

TASK PERFORMANCE:
- "Can you analyze..." / "Please analyze..."
- "I need help with..." / "Help me..."
- "Create a..." / "Build a..." / "Develop..."
- "Can someone..." / "Looking for someone to..."
- "Need assistance with..." / "Want to get..."
- Requests for reports, research, content creation, technical work
- Questions about getting work done or finding expertise

INFORMATION RETRIEVAL:
- "What's the latest on..." / "Any updates on..."
- "Looking for information about..." / "Need data on..."
- "What do you know about..." / "Can you find..."
- "Research shows..." / "Studies indicate..." (asking for verification)
- Requests for market data, trends, statistics, research findings
- Questions about current events, developments, or insights

Response Format:
- If the tweet is NOT asking for tasks or information retrieval, respond with: [SKIP_ACP]
- If the tweet IS asking for tasks or information retrieval, respond with:
  [USE_ACP]
  [KEYWORD:agent_specialization_keyword]
  [REQUIREMENT:detailed_task_or_information_request]

Examples:
- General conversation: "Nice weather today!" → [SKIP_ACP]
- Task request: "Can someone help me analyze this market data?" → 
  [USE_ACP]
  [KEYWORD:data analysis]
  [REQUIREMENT:Analyze market data mentioned in tweet. Deliverables: Comprehensive analysis report with insights and recommendations. Requirements: Financial analysis expertise, data visualization tools.]
- Information request: "What's the latest on AI developments?" → 
  [USE_ACP]
  [KEYWORD:research]
  [REQUIREMENT:Retrieve latest information on AI developments. Deliverables: Current AI trends report, recent developments summary, key insights. Requirements: Technology research expertise, information gathering capabilities.]

# Respond with the appropriate tags only. Focus on whether the tweet is explicitly or implicitly requesting work or information.
`;

/**
 * Parse ACP service response to extract decision and task details
 */
export const parseACPServiceResponse = (
    text: string
): { useACP: boolean; keyword?: string; requirement?: string } => {
    const result = {
        useACP: false,
        keyword: undefined,
        requirement: undefined
    };

    // Check for skip tag
    if (/\[SKIP_ACP\]/i.test(text)) {
        return result;
    }

    // Check for use tag
    if (/\[USE_ACP\]/i.test(text)) {
        result.useACP = true;
        
        // Extract keyword
        const keywordMatch = text.match(/\[KEYWORD:(.*?)\]/i);
        if (keywordMatch) {
            result.keyword = keywordMatch[1].trim();
        }
        
        // Extract requirement
        const requirementMatch = text.match(/\[REQUIREMENT:(.*?)\]/i);
        if (requirementMatch) {
            result.requirement = requirementMatch[1].trim();
        }
    }

    return result;
};

/**
 * Generate ACP service decision and task details in a single LLM call
 */
export async function generateACPServiceDecision({
    runtime,
    context,
    modelClass,
}: {
    runtime: IAgentRuntime;
    context: string;
    modelClass: ModelClass;
}): Promise<{ useACP: boolean; keyword?: string; requirement?: string } | null> {
    let retryDelay = 1000;
    while (true) {
        try {
            const response = await generateText({
                runtime,
                context,
                modelClass,
            });
            elizaLogger.debug(
                "[Virtuals ACP] Received response from generateText for ACP service decision:",
                response
            );
            const result = parseACPServiceResponse(response.trim());
            if (result.useACP !== undefined) {
                elizaLogger.debug("[Virtuals ACP] Parsed ACP service decision:", result);
                return result;
            } else {
                elizaLogger.debug("[Virtuals ACP] generateACPServiceDecision no valid response");
            }
        } catch (error) {
            elizaLogger.error("[Virtuals ACP] Error in generateACPServiceDecision:", error);
            if (
                error instanceof TypeError &&
                error.message.includes("queueTextCompletion")
            ) {
                elizaLogger.error(
                    "TypeError: Cannot read properties of null (reading 'queueTextCompletion')"
                );
            }
        }
        elizaLogger.log(`[Virtuals ACP] Retrying in ${retryDelay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay *= 2;
    }
}

/**
 * Determines whether ACP service should be used for a tweet and generates task details
 */
export async function shouldUseACPService(
    runtime: IAgentRuntime,
    state: any
): Promise<{ useACP: boolean; keyword?: string; requirement?: string }> {
    try {
        // Extract tweet information directly from state
        const tweetUsername = state.twitterUserName || '';

        // Create the action context using the provided state
        const acpServiceContext = composeContext({
            state,
            template: acpServiceTemplate,
        });

        // Get ACP service decision and task details using the specialized generator
        const acpServiceResponse = await generateACPServiceDecision({
            runtime: runtime,
            context: acpServiceContext,
            modelClass: ModelClass.MEDIUM,
        });

        if (acpServiceResponse) {
            if (acpServiceResponse.useACP) {
                elizaLogger.log(`[Virtuals ACP] Decision: Should use ACP service for user: ${tweetUsername}`);
                elizaLogger.log(`[Virtuals ACP] Generated keyword: "${acpServiceResponse.keyword}", requirement: "${acpServiceResponse.requirement?.substring(0, 100)}..."`);
            } else {
                elizaLogger.log(`[Virtuals ACP] Decision: Skip ACP service for user: ${tweetUsername}`);
            }
            return acpServiceResponse;
        } else {
            elizaLogger.log(`[Virtuals ACP] Decision: Skip ACP service for user: ${tweetUsername} (no valid response)`);
            return { useACP: false };
        }
    } catch (error) {
        elizaLogger.error("[Virtuals ACP] Error in ACP service decision process:", error);
        return { useACP: false }; // Default to not using ACP on error
    }
}

/**
 * Creates the initial tweet state for ACP processing
 */
async function createInitialState(
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
 * Template for generating job requirement object based on schema
 */
export const jobRequirementGenerationTemplate = `
# INSTRUCTIONS: Generate a JSON object that matches the provided schema requirements based on the job requirement text.

Schema: {{schema}}

Job Requirement Text: {{jobRequirement}}

Agent Offering Description: {{offeringDescription}}

# TASK: Extract or infer the required properties from the job requirement text to create a valid JSON object.

Guidelines:
1. Look for specific values mentioned in the job requirement text that match the required properties
2. For addresses: Look for patterns like 0x... (EVM addresses), alphanumeric strings that could be addresses
3. For chains: Look for chain names like "Base", "Solana", "Ethereum", "Polygon", etc.
4. For questions: Use the entire job requirement text as the question, or extract the main question part
5. For tokens: Look for $SYMBOL patterns or token addresses
6. For amounts: Look for numeric values
7. For requirements/descriptions: Use the job requirement text
8. If a required property is not found in the text, use a reasonable default or the full job requirement text
9. Ensure the JSON is valid and matches the schema structure

IMPORTANT: For "question" property, use the entire job requirement text if no specific question is found.

Response Format:
Return ONLY a valid JSON object that matches the schema requirements. Do not include any explanations or additional text.

Example:
If schema requires "chain" and "question", and the text mentions "Base network", the response should be:
{"chain": "base", "question": "Analyze blockchain address on Base network. Deliverables: Transaction history analysis, activity summary, potential insights. Requirements: Blockchain analysis expertise, data interpretation skills."}
`;

/**
 * Dynamically generate job requirement object using LLM based on agent's offering schema
 */
async function generateJobRequirementObject(
    jobRequirement: string,
    chosenJobOffering: any,
    runtime: IAgentRuntime
): Promise<any> {
    elizaLogger.debug("[Virtuals ACP] Generating job requirement object for:", jobRequirement);
    elizaLogger.debug("[Virtuals ACP] Job offering type:", chosenJobOffering.type);
    
    try {
        // If no schema is provided, use the simple requirement format
        if (!chosenJobOffering.requirementSchema) {
            elizaLogger.debug("[Virtuals ACP] No schema provided, using simple requirement format");
            return { "requirement": jobRequirement };
        }

        const schema = chosenJobOffering.requirementSchema;
        elizaLogger.debug("[Virtuals ACP] Agent offering schema:", JSON.stringify(schema, null, 2));
        elizaLogger.debug("[Virtuals ACP] Job requirement text:", jobRequirement);

        // Use LLM to generate the job requirement object
        const generationContext = composeContext({
            state: {
                schema: JSON.stringify(schema, null, 2),
                jobRequirement: jobRequirement,
                offeringDescription: chosenJobOffering.type || "No description available",
                // Add required state properties
                bio: "",
                lore: "",
                messageDirections: "",
                postDirections: "",
                topics: "",
                knowledge: "",
                providers: "",
                characterMessageExamples: "",
                recentPostInteractions: "",
                recentPosts: "",
                currentPost: jobRequirement,
                formattedConversation: "",
                imageDescriptions: "",
                quotedContent: "",
                twitterUserName: "",
                agentName: "",
                actionNames: "",
                actions: "",
                CARVInsights: "",
                ACPJobStatus: "",
                roomId: stringToUuid("temp-room"),
                actors: "",
                recentMessages: [] as any,
                recentMessagesData: [] as any
            },
            template: jobRequirementGenerationTemplate,
        });

        elizaLogger.debug("[Virtuals ACP] Generating job requirement object with LLM...");
        
        const response = await generateText({
            runtime,
            context: generationContext,
            modelClass: ModelClass.MEDIUM,
        });

        elizaLogger.debug("[Virtuals ACP] LLM response:", response);

        // Parse the JSON response
        let result: any;
        try {
            // Clean the response to extract just the JSON
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                result = JSON.parse(jsonMatch[0]);
            } else {
                throw new Error("No valid JSON found in response");
            }
        } catch (parseError) {
            elizaLogger.error("[Virtuals ACP] Failed to parse LLM response as JSON:", parseError);
            elizaLogger.error("[Virtuals ACP] Raw response:", response);
            throw new Error(`Failed to parse generated job requirement object: ${parseError.message}`);
        }

        // Validate that all required properties are present
        if (schema.required && Array.isArray(schema.required)) {
            const missingProps: string[] = [];
            for (const requiredProp of schema.required) {
                if (!result.hasOwnProperty(requiredProp) || result[requiredProp] === undefined || result[requiredProp] === null) {
                    missingProps.push(requiredProp);
                }
            }

            if (missingProps.length > 0) {
                const errorMessage = `Missing required properties: ${missingProps.join(', ')}. LLM failed to extract these from the job requirement. Please provide more specific information in your request.`;
                elizaLogger.error(`[Virtuals ACP] Schema validation failed: ${errorMessage}`);
                throw new Error(errorMessage);
            }
        }

        elizaLogger.debug("[Virtuals ACP] Generated job requirement object:", result);
        elizaLogger.debug("[Virtuals ACP] Final result object:", JSON.stringify(result, null, 2));
        return result;
    } catch (error) {
        elizaLogger.error("[Virtuals ACP] Error generating job requirement object:", error);
        throw new Error(`Failed to generate job requirement object: ${error.message}`);
    }
}

/**
 * Generates a unique price by adding a small random decimal to the base price
 * This ensures each payment request has a unique amount for tracking
 * 
 * Approach: Add a random decimal between 0.000001 and 0.009999 to the base price
 * This provides ~10,000 unique combinations while keeping the price increase minimal
 * 
 * @param basePrice The original price from the agent offering
 * @returns A unique price with a small random decimal addition
 */
function generateUniquePrice(basePrice: number): number {
    // Validate input
    if (typeof basePrice !== 'number' || basePrice <= 0) {
        throw new Error(`Invalid base price: ${basePrice}. Must be a positive number.`);
    }

    // Generate a random decimal between 0.000001 and 0.009999 (~10k combinations)
    const randomDecimal = Math.random() * (0.009999 - 0.000001) + 0.000001;
    // Round to 6 decimal places to avoid floating point precision issues
    const uniquePrice = Math.round((basePrice + randomDecimal) * 1000000) / 1000000;

    elizaLogger.debug(`[Virtuals ACP] Generated unique price: ${basePrice} + ${randomDecimal.toFixed(6)} = ${uniquePrice}`);
    return uniquePrice;
}

/**
 * Interface for storing ACP agent details in cache
 */
export interface ACPAgentDetails {
    agentId: number;
    agentName: string;
    agentAddress: string;
    offeringType: string;
    offeringSchema?: any;
    offeringPrice: number;
    price: number;
    jobRequirement: string;
    keyword: string;
    requirement: any;
    status: 'pending_payment' | 'paid' | 'completed' | 'failed';
    isSelfRespondACP: boolean;
    arbusData: string;
    createdAt: number;
}

async function searchACPAgent(twitterConfig: TwitterConfig, agentFilterKeyword: string, jobRequirement: string, runtime: IAgentRuntime, isSelfRespondACP: boolean): Promise<{ agentDetails: ACPAgentDetails | null; error?: string }> {
    try {
        // Dynamic import to avoid constructor issues
        const AcpModule = await import("@virtuals-protocol/acp-node");

        // Try all possible locations for the class
        const AcpClient = (AcpModule as any).default?.default || (AcpModule as any).default || (AcpModule as any).AcpClient;
        const { AcpContractClient, baseAcpConfig, AcpAgentSort, AcpOnlineStatus, AcpGraduationStatus } = AcpModule;

        const acpClient = new AcpClient({
            acpContractClient: await AcpContractClient.build(
                twitterConfig.VIRTUALS_ACP_BUYER_PRIVATE_KEY as Address,
                twitterConfig.VIRTUALS_ACP_BUYER_ENTITY_ID,
                twitterConfig.VIRTUALS_ACP_BUYER_WALLET_ADDRESS as Address,
                baseAcpConfig,
            ),
        });

        let chosenJobOffering: any;
        let chosenAgent: any;
        let arbusData: string;

        // Check if we should use a specific configured agent for SELF_RESPOND_ACP
        if (isSelfRespondACP) {
            try {
                elizaLogger.debug("[Virtuals ACP] Using configured agent for SELF_RESPOND_ACP.");
                // Get the agent by wallet address
                const agent = await acpClient.getAgent(twitterConfig.VIRTUALS_ACP_SELLER_WALLET_ADDRESS as Address);
                if (!agent || !agent.offerings || agent.offerings.length === 0) {
                    elizaLogger.warn("[Virtuals ACP] No offerings available for configured agent");
                    return { agentDetails: null, error: "No offerings available for the configured agent." };
                }
                chosenJobOffering = agent.offerings[0];
                elizaLogger.debug("[Virtuals ACP] Chosen job offering:", chosenJobOffering.type);
                chosenAgent = agent;
                elizaLogger.debug("[Virtuals ACP] Using configured agent:", chosenAgent);

                // Get Arbus response and also check if it has response.
                const fetchData = await fetchArbusApi(twitterConfig.ARBUS_API_KEY, jobRequirement);
                arbusData = fetchData.response;
                elizaLogger.debug('[Virtuals ACP] Got Arbus API response:', arbusData);
            } catch (error) {
                elizaLogger.error("[Virtuals ACP] Error getting configured agent:", error);
                return { agentDetails: null, error: "Error accessing configured agent. Please try again." };
            }
        } else {
            // Browse available agents based on a keyword and cluster name
            try {
                elizaLogger.debug("[Virtuals ACP] Browsing agents...");
                const relevantAgents = await acpClient.browseAgents(
                    agentFilterKeyword,
                    {
                        sort_by: [AcpAgentSort.SUCCESSFUL_JOB_COUNT],
                        top_k: 5,
                        graduationStatus: AcpGraduationStatus.GRADUATED,
                        onlineStatus: AcpOnlineStatus.ONLINE,
                    }
                );
                if (relevantAgents.length === 0) {
                    elizaLogger.warn("[Virtuals ACP] No relevant agents found");
                    return { agentDetails: null, error: "No suitable agents found for your request." };
                }
                chosenAgent = relevantAgents[0];
                elizaLogger.debug("[Virtuals ACP] Chosen agent:", chosenAgent.name);
                if (!chosenAgent.offerings || chosenAgent.offerings.length === 0) {
                    elizaLogger.warn("[Virtuals ACP] No offerings available for chosen agent");
                    return { agentDetails: null, error: "No offerings available for the selected agent." };
                }
                chosenJobOffering = chosenAgent.offerings[0];
                elizaLogger.debug("[Virtuals ACP] Chosen job offering:", chosenJobOffering.type);
            } catch (error) {
                elizaLogger.error("[Virtuals ACP] Error during agent browsing:", error);
                if (error instanceof Error) {
                    elizaLogger.error("[Virtuals ACP] Operation error name:", error.name);
                    elizaLogger.error("[Virtuals ACP] Operation error message:", error.message);
                    elizaLogger.error("[Virtuals ACP] Operation error stack:", error.stack);
                }
                return { agentDetails: null, error: "Error searching for agents. Please try again." };
            }
        }

        // Generate the job requirement object based on the agent's schema
        let jobRequirementObject: any;
        try {
            jobRequirementObject = await generateJobRequirementObject(jobRequirement, chosenJobOffering, runtime);
            elizaLogger.debug("[Virtuals ACP] Generated job requirement object:", jobRequirementObject);
        } catch (error) {
            elizaLogger.error("[Virtuals ACP] Failed to generate job requirement object:", error);
            return { 
                agentDetails: null, 
                error: `${error.message}. Please provide more specific information in your request.`
            };
        }

        // Generate unique price for this request
        const uniquePrice = generateUniquePrice(chosenJobOffering.price);

        // Create agent details
        const agentDetails: ACPAgentDetails = {
            agentId: chosenAgent.id,
            agentName: chosenAgent.name,
            agentAddress: chosenAgent.walletAddress,
            offeringType: chosenJobOffering.type,
            offeringSchema: chosenJobOffering.requirementSchema,
            offeringPrice: chosenJobOffering.price,
            price: uniquePrice, // Use unique price instead of base price
            jobRequirement: jobRequirement,
            keyword: agentFilterKeyword, // Use the original search keyword instead of non-existent offering keyword
            requirement: jobRequirementObject,
            status: "pending_payment",
            isSelfRespondACP: isSelfRespondACP,
            arbusData: arbusData,
            createdAt: Date.now()
        };

        elizaLogger.log(`[Virtuals ACP] Successfully found agent: ${agentDetails.agentName} with base price: ${chosenJobOffering.price} $USDC, unique price: ${agentDetails.price} $USDC`);
        return { agentDetails };
    } catch (error) {
        elizaLogger.error("[Virtuals ACP] Error creating ACP Client:", error);
        if (error instanceof Error) {
            elizaLogger.error("[Virtuals ACP] Error name:", error.name);
            elizaLogger.error("[Virtuals ACP] Error message:", error.message);
            elizaLogger.error("[Virtuals ACP] Error stack:", error.stack);
        }
        return { agentDetails: null, error: "Error creating ACP client. Please try again." };
    }
}

/**
 * Monitor ACP service response with retries using existing AcpClient
 * This is still needed for the payment confirmation flow
 */
async function monitorACPServiceResponse(
    acpClient: any,
    jobId: string,
    AcpJobPhases: any,
    maxRetries: number = 30, // 5 minutes
    retryDelay: number = 10000
): Promise<string | null> {
    elizaLogger.log(`[Virtuals ACP] Starting response monitoring for job ${jobId}`);
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            elizaLogger.debug(`[Virtuals ACP] Attempt ${attempt}/${maxRetries} - Checking for seller response`);

            // Try to get job details to check for response
            try {
                const job = await acpClient.getJobById(jobId);
                if (job) {
                    // Use the deliverable getter which automatically finds the COMPLETED memo
                    const deliverable = job.deliverable;
                    if (deliverable) {
                        elizaLogger.log(`[Virtuals ACP] Found seller response for job ${jobId}:`, deliverable);
                        return deliverable;
                    }

                    // Check if job is completed - if so, return success response even if no deliverable
                    if (job.phase === AcpJobPhases.COMPLETED) {
                        elizaLogger.log(`[Virtuals ACP] Job ${jobId} is completed with success response`);
                        return "Job completed successfully. No additional data provided.";
                    } else if (job.phase === AcpJobPhases.FAILED) {
                        elizaLogger.log(`[Virtuals ACP] Job ${jobId} failed on attempt ${attempt}`);
                        return "Job failed. Please try again or contact support.";
                    } else {
                        elizaLogger.debug(`[Virtuals ACP] Job ${jobId} still in progress, phase: ${job.phase}`);
                    }
                } else {
                    elizaLogger.debug(`[Virtuals ACP] Job ${jobId} not found`);
                }
            } catch (jobError) {
                elizaLogger.debug(`[Virtuals ACP] Could not retrieve job ${jobId} status on attempt ${attempt}:`, jobError);
            }

            if (attempt < maxRetries) {
                elizaLogger.debug(`[Virtuals ACP] No response yet, waiting ${retryDelay}ms before next attempt`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        } catch (error) {
            elizaLogger.error(`[Virtuals ACP] Error during response monitoring attempt ${attempt}:`, error);
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }
    }
    
    // After all retries, check one final time for job status
    try {
        const job = await acpClient.getJobById(jobId);
        if (job) {
            if (job.phase === AcpJobPhases.COMPLETED) {
                // Job completed but no deliverable - return success response
                elizaLogger.log(`[Virtuals ACP] Job ${jobId} completed with success response after monitoring timeout`);
                return "Job completed successfully. No additional data provided.";
            } else if (job.phase === AcpJobPhases.FAILED) {
                elizaLogger.log(`[Virtuals ACP] Job ${jobId} failed after monitoring timeout`);
                return "Job failed. Please try again or contact support.";
            } else {
                elizaLogger.log(`[Virtuals ACP] Job ${jobId} still in progress after monitoring timeout, phase: ${job.phase}`);
                return "Job is still in progress. Please check back later for updates.";
            }
        }
    } catch (finalError) {
        elizaLogger.error(`[Virtuals ACP] Error checking final job status:`, finalError);
    }
    
    elizaLogger.log(`[Virtuals ACP] No seller response found after ${maxRetries} attempts for job ${jobId}`);
    return "Job monitoring timeout. Please check back later for updates.";
}

/**
 * Checks for ERC-20 token transfer transactions on Base mainnet using Alchemy Transfers API
 * Looks for specific $USDC token transfers to the wallet address
 */
async function checkForVirtualTokenPayment(
    walletAddress: string,
    requiredAmount: number,
    maxAttempts: number = 12, // 2 minutes (12 * 10 seconds)
    pollInterval: number = 10000 // 10 seconds
): Promise<boolean> {
    try {
        // Dynamic import to avoid constructor issues
        const AcpModule = await import("@virtuals-protocol/acp-node");
        const { baseAcpConfig } = AcpModule;

        // Convert required amount to wei for comparison
        const requiredAmountWei = parseUnits(requiredAmount.toString(), 6); // USDC token has 6 decimals

        elizaLogger.log(`[Virtuals ACP] Starting payment verification for ${requiredAmount} $USDC tokens to ${walletAddress}`);

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                elizaLogger.log(`[Virtuals ACP] Attempt ${attempt}/${maxAttempts}: Checking for transfer transactions...`);

                // Use Alchemy Transfers API to get asset transfers
                const response = await fetch(baseAcpConfig.alchemyRpcUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'alchemy_getAssetTransfers',
                        params: [
                            {
                                toAddress: walletAddress,
                                category: ['erc20'],
                                order: 'desc' // Most recent first
                            }
                        ],
                        id: 1
                    })
                });
                if (!response.ok) {
                    throw new Error(`Alchemy API request failed: ${response.status} ${response.statusText}`);
                }

                const data = await response.json();
                if (data.error) {
                    throw new Error(`Alchemy API error: ${data.error.message}`);
                }

                const transfers = data.result?.transfers || [];
                // Check if any transfer matches our required amount
                for (const transfer of transfers) {
                    // Check if this transfer is for the USDC token
                    if (transfer.rawContract.address.toLowerCase() !== "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913") {
                        continue; // Skip transfers for other tokens
                    }

                    // Convert the transfer value to wei for comparison
                    const transferValueWei = BigInt(transfer.rawContract.value);
                    if (transferValueWei === requiredAmountWei) {
                        elizaLogger.log(`[Virtuals ACP] Payment found! Transfer: ${parseFloat(transfer.value)} $USDC in transaction: ${transfer.hash}`);
                        return true;
                    }
                }

                // Wait before next attempt (except on last attempt)
                if (attempt < maxAttempts) {
                    elizaLogger.log(`[Virtuals ACP] No matching payment found, waiting ${pollInterval/1000} seconds...`);
                    await new Promise(resolve => setTimeout(resolve, pollInterval));
                }
            } catch (error) {
                elizaLogger.error(`[Virtuals ACP] Error checking transfers on attempt ${attempt}:`, error);
                if (attempt < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, pollInterval));
                }
            }
        }

        elizaLogger.log(`[Virtuals ACP] Payment verification timeout after ${maxAttempts} attempts`);
        return false;
    } catch (error) {
        elizaLogger.error("[Virtuals ACP] Error setting up payment verification:", error);
        return false;
    }
}

/**
 * Cache-based storage and retrieval functions for ACP data
 */

/**
 * Store ACP agent details in cache
 */
async function storeACPAgentDetails(
    runtime: IAgentRuntime,
    tweetId: string,
    agentDetails: ACPAgentDetails
): Promise<void> {
    const cacheKey = `acp/agent-details/${tweetId}`;
    elizaLogger.log(`[Virtuals ACP] Storing agent details in cache: ${cacheKey}`);

    try {
        await runtime.cacheManager.set(cacheKey, agentDetails, {
            expires: Date.now() + 24 * 60 * 60 * 1000 // 24 hours
        });
        elizaLogger.log(`[Virtuals ACP] Successfully stored agent details for tweet ${tweetId}`);
    } catch (error) {
        elizaLogger.error(`[Virtuals ACP] Failed to store agent details in cache:`, error);
        throw error;
    }
}

/**
 * Retrieve ACP agent details from cache
 */
async function getACPAgentDetails(
    runtime: IAgentRuntime,
    tweetId: string
): Promise<ACPAgentDetails | null> {
    const cacheKey = `acp/agent-details/${tweetId}`;
    elizaLogger.log(`[Virtuals ACP] Retrieving agent details from cache: ${cacheKey}`);

    try {
        const agentDetails = await runtime.cacheManager.get<ACPAgentDetails>(cacheKey);
        if (agentDetails) {
            elizaLogger.log(`[Virtuals ACP] Found agent details for tweet ${tweetId}:`, {
                agentName: agentDetails.agentName,
                price: agentDetails.price,
                status: agentDetails.status
            });
            return agentDetails;
        } else {
            elizaLogger.log(`[Virtuals ACP] No agent details found for tweet ${tweetId}`);
            return null;
        }
    } catch (error) {
        elizaLogger.error(`[Virtuals ACP] Error retrieving agent details from cache:`, error);
        return null;
    }
}

/**
 * Update ACP agent details status in cache
 */
async function updateACPAgentStatus(
    runtime: IAgentRuntime,
    tweetId: string,
    newStatus: ACPAgentDetails['status']
): Promise<void> {
    const agentDetails = await getACPAgentDetails(runtime, tweetId);
    if (agentDetails) {
        agentDetails.status = newStatus;
        await storeACPAgentDetails(runtime, tweetId, agentDetails);
        elizaLogger.log(`[Virtuals ACP] Updated agent status to ${newStatus} for tweet ${tweetId}`);
    } else {
        elizaLogger.warn(`[Virtuals ACP] Cannot update status - no agent details found for tweet ${tweetId}`);
    }
}

export async function processVirtualsACP(
    runtime: IAgentRuntime,
    twitterUsername: string,
    tweet: Tweet,
    formattedConversation: string,
    imageDescriptions: string[] = [],
    quotedContent: string = "",
    twitterConfig: TwitterConfig,
    shouldRespond: string
): Promise<{ sellerResponse: string; ACPPaymentAmount?: number }> {
    if (!twitterConfig.VIRTUALS_ACP_BUYER_WALLET_ADDRESS) {
        elizaLogger.error("[Virtuals ACP] VIRTUALS_ACP_WALLET_ADDRESS is not set");
        return { sellerResponse: "Error: ACP wallet address not configured" };
    }
    if (!twitterConfig.VIRTUALS_ACP_BUYER_ENTITY_ID) {
        elizaLogger.error("[Virtuals ACP] VIRTUALS_ACP_ENTITY_ID is not set");
        return { sellerResponse: "Error: ACP entity ID not configured" };
    }
    if (!twitterConfig.VIRTUALS_ACP_BUYER_PRIVATE_KEY) {
        elizaLogger.error("[Virtuals ACP] VIRTUALS_ACP_BUYER_PRIVATE_KEY is not set");
        return { sellerResponse: "Error: ACP private key not configured" };
    }
    if (!twitterConfig.VIRTUALS_ACP_SELLER_WALLET_ADDRESS) {
        elizaLogger.error("[Virtuals ACP] VIRTUALS_ACP_SELLER_WALLET_ADDRESS is not set");
        return { sellerResponse: "Error: ACP seller wallet address not configured" };
    }

    let sellerResponse = "";
    try {
        if (shouldRespond === "RESPOND_ACP" || shouldRespond === "SELF_RESPOND_ACP") {
            elizaLogger.log(`[Virtuals ACP] Processing RESPOND_ACP for tweet ${tweet.id}: "${tweet.text?.substring(0, 100)}..."`);

            // First flow: Search for agent and provide payment instructions
            // 1. Create initial state for decision making
            const initialState = await createInitialState(
                runtime,
                twitterUsername,
                tweet,
                formattedConversation,
                imageDescriptions,
                quotedContent
            );

            // 2. Determine if we should use ACP service
            const shouldUseACP = await shouldUseACPService(runtime, initialState);

            elizaLogger.log(`[Virtuals ACP] ACP service decision for tweet ${tweet.id}: useACP=${shouldUseACP.useACP}, keyword="${shouldUseACP.keyword}", requirement="${shouldUseACP.requirement?.substring(0, 100)}..."`);

            if (shouldUseACP.useACP) {
                // Get the tweet text from the tweet object
                const tweetText = tweet.text || '';

                if (tweetText) {
                    elizaLogger.log(`[Virtuals ACP] Processing ACP service for tweet from @${tweet.username}`);
                    elizaLogger.log(`[Virtuals ACP] Tweet content: "${tweetText.substring(0, 50)}..."`);

                    // 3. Search for ACP agent (first flow - search and store agent details)
                    const { agentDetails, error } = await searchACPAgent(twitterConfig, shouldUseACP.keyword!, shouldUseACP.requirement!, runtime, shouldRespond === "SELF_RESPOND_ACP");

                    if (agentDetails) {
                        // Store agent details in cache for easy retrieval during payment confirmation
                        elizaLogger.log(`[Virtuals ACP] Storing agent details in cache for tweet ${tweet.id}`);

                        try {
                            // Store agent details in cache
                            await storeACPAgentDetails(runtime, tweet.id, agentDetails);
                            elizaLogger.log(`[Virtuals ACP] Successfully stored agent details and payment instructions in cache for tweet ${tweet.id}`);
                        } catch (error) {
                            elizaLogger.error(`[Virtuals ACP] Failed to store agent details in cache:`, error);
                            return { sellerResponse: "Error: Failed to store agent details. Please try again.", ACPPaymentAmount: agentDetails.price };
                        }

                        // Format the result for Twitter with payment instructions
                        let resultText = `I found an agent that can help with your request!\n\n`;
                        resultText += `Agent: ${agentDetails.agentName}\n`;
                        resultText += `Service: ${agentDetails.offeringType}\n`;
                        resultText += `Price: ${agentDetails.price} $USDC\n\n`;
                        resultText += `To proceed, please send ${agentDetails.price} $USDC on Base to ${twitterConfig.VIRTUALS_ACP_BUYER_WALLET_ADDRESS}\n\n`;
                        resultText += `Once you've sent the payment, please reply to this tweet to let me know it's been sent!`;

                        sellerResponse = resultText;

                        // Log successful agent selection
                        elizaLogger.debug('[Virtuals ACP] Successfully selected agent for payment flow', {
                            tweetId: tweet.id,
                            username: tweet.username,
                            agentId: agentDetails.agentId,
                            agentName: agentDetails.agentName,
                            price: agentDetails.price,
                            keyword: shouldUseACP.keyword,
                            requirementLength: shouldUseACP.requirement!.length
                        });

                        // Handle SELF_RESPOND_ACP
                        if (agentDetails.isSelfRespondACP && agentDetails.arbusData) {
                            sellerResponse = agentDetails.arbusData;
                        }

                        // Return with agent details for storage
                        return { sellerResponse, ACPPaymentAmount: agentDetails.price };
                    } else {
                        elizaLogger.log('[Virtuals ACP] Failed to find suitable agent');
                        sellerResponse = error || "Could not find a suitable agent for your request. Please try again later.";
                    }
                } else {
                    elizaLogger.warn('[Virtuals ACP] Tweet has no text content');
                    sellerResponse = "Error: Tweet has no text content for ACP processing.";
                }
            } else {
                elizaLogger.log('[Virtuals ACP] Decision: Not using ACP job for this tweet');
                sellerResponse = ""; // Return empty string when not using ACP
            }
        } else if (shouldRespond === "RESPOND_PAYMENT_CONFIRMED") {
            elizaLogger.log(`[Virtuals ACP] Processing RESPOND_PAYMENT_CONFIRMED for tweet ${tweet.id}`);
            // Second flow: Handle payment confirmation
            const paymentResult = await processACPPaymentConfirmation(
                runtime,
                tweet,
                twitterConfig
            );
            sellerResponse = paymentResult.sellerResponse;
        } else {
            elizaLogger.log(`[Virtuals ACP] Not an ACP-related response decision: ${shouldRespond} for tweet ${tweet.id}`);
            sellerResponse = ""; // Return empty string for non-ACP responses
        }
    } catch (error) {
        elizaLogger.error(`[Virtuals ACP] Error in ACP job processing: ${error}`, error);
        sellerResponse = `Error processing ACP job: ${error}`;
    }

    // Return sellerResponse for all cases where agentDetails is not available
    return { sellerResponse };
}

/**
 * Handles the payment confirmation flow (second flow)
 * This function is called internally by processVirtualsACP
 */
async function processACPPaymentConfirmation(
    runtime: IAgentRuntime,
    tweet: Tweet,
    twitterConfig: TwitterConfig
): Promise<{ sellerResponse: string; success: boolean }> {
    try {
        elizaLogger.log(`[Virtuals ACP] Processing payment confirmation for tweet ${tweet.id}`);

        // The payment confirmation tweet is a reply to the payment instructions tweet
        // The original request tweet ID is the conversation ID (this is how Twitter works)
        const originalTweetId = tweet.conversationId;
        elizaLogger.log(`[Virtuals ACP] Looking for agent details for original request tweet: ${originalTweetId}`);

        const agentDetails = await getACPAgentDetails(runtime, originalTweetId);

        if (!agentDetails) {
            elizaLogger.warn(`[Virtuals ACP] No agent details found for payment confirmation`);
            return { sellerResponse: "Error: No agent details found. Please start a new ACP request.", success: false };
        }

        if (agentDetails.status !== 'pending_payment') {
            elizaLogger.warn(`[Virtuals ACP] Agent details status is not pending_payment: ${agentDetails.status}`);
            return { sellerResponse: "Error: Payment already processed or job already completed.", success: false };
        }

        elizaLogger.log(`[Virtuals ACP] Processing payment confirmation for agent: ${agentDetails.agentName}, Price: ${agentDetails.price} $USDC`);

        // Check for payment
        const paymentReceived = await checkForVirtualTokenPayment(
            twitterConfig.VIRTUALS_ACP_BUYER_WALLET_ADDRESS!,
            agentDetails.price
        );

        if (paymentReceived) {
            elizaLogger.log(`[Virtuals ACP] Payment confirmed! Initiating job with agent ${agentDetails.agentName}`);

            // Update agent status to paid in cache
            await updateACPAgentStatus(runtime, originalTweetId!, 'paid');

            if (agentDetails.isSelfRespondACP) {
                // Responding using Arbus flow
                elizaLogger.log(`[Virtuals ACP] Responding using Arbus API flow for tweet ${originalTweetId}`);

                // Update agent status to completed in cache
                await updateACPAgentStatus(runtime, originalTweetId!, 'completed');

                return {
                    sellerResponse: agentDetails.arbusData,
                    success: true
                }
            } else {
                // Regular buy flow

                // Buy ACP service using stored agent details
                const { acpClient, jobId, AcpJobPhases, sellerResponse } = await buyACPServiceWithStoredAgent(
                    twitterConfig,
                    agentDetails
                );

                if (jobId) {
                    // Check for immediate seller response
                    let finalSellerResponse = sellerResponse;

                    // If no immediate response, monitor for delayed seller response
                    if (!finalSellerResponse) {
                        elizaLogger.log(`[Virtuals ACP] No immediate seller response, monitoring for delayed response for job ${jobId}`);
                        finalSellerResponse = await monitorACPServiceResponse(acpClient, jobId, AcpJobPhases);
                    } else {
                        elizaLogger.log(`[Virtuals ACP] Immediate seller response received for job ${jobId}`);
                    }

                    // Update agent status to completed in cache
                    await updateACPAgentStatus(runtime, originalTweetId!, 'completed');

                    if (finalSellerResponse) {
                        elizaLogger.log(`[Virtuals ACP] Job completed successfully with response`);
                        return { 
                            sellerResponse: `Payment received! Job completed successfully.\n\nSeller Response:\n${finalSellerResponse}`,
                            success: true 
                        };
                    } else {
                        elizaLogger.log(`[Virtuals ACP] Job completed but no seller response received`);
                        return { 
                            sellerResponse: `Payment received! Job completed successfully. No additional data provided.`,
                            success: true 
                        };
                    }
                } else {
                    elizaLogger.error(`[Virtuals ACP] Failed to initiate job after payment confirmation`);
                    return { 
                        sellerResponse: `Payment received but failed to initiate the job. Please try again or contact support.`,
                        success: false 
                    };
                }
            }
            } else {
                elizaLogger.log(`[Virtuals ACP] Payment not received within timeout period`);
                return { 
                    sellerResponse: `Payment not received. Please send ${agentDetails.price} $USDC on Base to ${twitterConfig.VIRTUALS_ACP_BUYER_WALLET_ADDRESS} and reply to this tweet again.`,
                    success: false 
                };
            }
    } catch (error) {
        elizaLogger.error(`[Virtuals ACP] Error in payment confirmation processing: ${error}`, error);
        return { 
            sellerResponse: `Error processing payment confirmation: ${error}`,
            success: false 
        };
    }
}

/**
 * Buys ACP service using stored agent details (for payment confirmation flow)
 */
async function buyACPServiceWithStoredAgent(
    twitterConfig: TwitterConfig,
    agentDetails: ACPAgentDetails,
): Promise<{ acpClient: any; jobId: string | null; AcpJobPhases: any; sellerResponse: string }> {
    let sellerResponse: string | undefined;

    try {
        // Dynamic import to avoid constructor issues
        const AcpModule = await import("@virtuals-protocol/acp-node");

        // Try all possible locations for the class
        const AcpClient = (AcpModule as any).default?.default || (AcpModule as any).default || (AcpModule as any).AcpClient;
        const { AcpContractClient, AcpJobPhases, baseAcpConfig, FareAmount } = AcpModule;

        const acpClient = new AcpClient({
            acpContractClient: await AcpContractClient.build(
                twitterConfig.VIRTUALS_ACP_BUYER_PRIVATE_KEY as Address,
                twitterConfig.VIRTUALS_ACP_BUYER_ENTITY_ID,
                twitterConfig.VIRTUALS_ACP_BUYER_WALLET_ADDRESS as Address,
                baseAcpConfig,
            ),
            onNewTask: async (job: any, memoToSign?: any) => {
                elizaLogger.log("[Virtuals ACP] New task received:", job.id);
                if (
                    job.phase === AcpJobPhases.NEGOTIATION &&
                    (memoToSign?.nextPhase === AcpJobPhases.TRANSACTION)
                ) {
                    elizaLogger.log("[Virtuals ACP] Paying job", job.id);
                    try {
                        await job.pay(job.price);
                        elizaLogger.log(`[Virtuals ACP] Job ${job.id} paid successfully`);
                    } catch (error) {
                        elizaLogger.error(`[Virtuals ACP] Error paying job ${job.id}:`, error);
                    }
                } else if (job.phase === AcpJobPhases.COMPLETED) {
                    elizaLogger.log(`[Virtuals ACP] Job ${job.id} completed`);

                    // Use the deliverable getter to check for seller response
                    const deliverable = job.deliverable;
                    if (deliverable) {
                        sellerResponse = deliverable;
                        elizaLogger.log(`[Virtuals ACP] Seller response received for job ${job.id}:`, sellerResponse);
                    } else {
                        // Even if no specific deliverable, job completion is a success response
                        sellerResponse = "Job completed successfully. No additional data provided.";
                        elizaLogger.log(`[Virtuals ACP] Job ${job.id} completed with success response`);
                    }
                }
            },
            onEvaluate: async (job: any) => {
                elizaLogger.log("[Virtuals ACP] Evaluation function called for job:", job.id);
                try {
                    // Use the deliverable getter to check for seller response before evaluating
                    const deliverable = job.deliverable;
                    if (deliverable) {
                        sellerResponse = deliverable;
                        elizaLogger.log(`[Virtuals ACP] Seller response found during evaluation for job ${job.id}:`, sellerResponse);
                    } else {
                        // Even if no specific deliverable, job completion is a success response
                        sellerResponse = "Job completed successfully. No additional data provided.";
                        elizaLogger.log(`[Virtuals ACP] Job ${job.id} evaluated with success response`);
                    }

                    await job.evaluate(true, "Self-evaluated and approved");
                    elizaLogger.log(`[Virtuals ACP] Job ${job.id} evaluated successfully`);
                } catch (error) {
                    elizaLogger.error(`[Virtuals ACP] Error evaluating job ${job.id}:`, error);
                }
            },
        });

        try {
            let jobId: any;
            try {
                jobId = await acpClient.initiateJob(
                    agentDetails.agentAddress,
                    agentDetails.requirement,
                    new FareAmount(agentDetails.offeringPrice, acpClient.acpContractClient.config.baseFare),
                    twitterConfig.VIRTUALS_ACP_BUYER_WALLET_ADDRESS as Address,
                    new Date(Date.now() + 1000 * 60 * 60 * 24), // expiredAt as last parameter
                );
            } catch (error) {
                elizaLogger.error("[Virtuals ACP] Error initiating job:", error);
                if (error instanceof Error && error.message.includes("data must have required property")) {
                    const errorMessage = `Schema validation failed: ${error.message}. Please check the job requirement format.`;
                    elizaLogger.error("[Virtuals ACP]", errorMessage);
                    return { 
                        acpClient: null, 
                        jobId: null, 
                        AcpJobPhases: null, 
                        sellerResponse: `Error: ${errorMessage}`
                    };
                } else {
                    return { 
                        acpClient: null, 
                        jobId: null, 
                        AcpJobPhases: null, 
                        sellerResponse: `Error initiating ACP job: ${error instanceof Error ? error.message : 'Unknown error'}`
                    };
                }
            }

            elizaLogger.log(`[Virtuals ACP] Job ${jobId} initiated successfully with stored agent`);
            return { acpClient, jobId, AcpJobPhases, sellerResponse };
        } catch (error) {
            elizaLogger.error("[Virtuals ACP] Error during agent retrieval or job initiation:", error);
            if (error instanceof Error) {
                elizaLogger.error("[Virtuals ACP] Operation error name:", error.name);
                elizaLogger.error("[Virtuals ACP] Operation error message:", error.message);
                elizaLogger.error("[Virtuals ACP] Operation error stack:", error.stack);
            }
            return { acpClient: null, jobId: null, AcpJobPhases: null, sellerResponse: "Error: Failed to retrieve agent or initiate job" };
        }
    } catch (error) {
        elizaLogger.error("[Virtuals ACP] Error creating ACP Client:", error);
        if (error instanceof Error) {
            elizaLogger.error("[Virtuals ACP] Error name:", error.name);
            elizaLogger.error("[Virtuals ACP] Error message:", error.message);
            elizaLogger.error("[Virtuals ACP] Error stack:", error.stack);
        }
        return { acpClient: null, jobId: null, AcpJobPhases: null, sellerResponse: "Error: Failed to create ACP client" };
    }
}

async function fetchArbusApi(apiKey: string, query: string, days: number = 45, maxAttempts: number = 5, retryDelay: number = 2000): Promise<any> {
    let lastError: any = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await fetch(`https://api.arbus.ai/v1/ask-ai-assistant?key=${apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query, days })
                }
            );
            if (!response.ok) {
                throw new Error(`Arbus API request failed: ${response.status} ${response.statusText}`);
            }
            const data = await response.json();
            if (data && data.response) {
                return data;
            } else {
                throw new Error("No valid response from Arbus API");
            }
        } catch (error) {
            lastError = error;
            elizaLogger.error(`[Virtuals ACP] Error fetching from Arbus API (attempt ${attempt}):`, error);
            if (attempt < maxAttempts) {
                await new Promise(res => setTimeout(res, retryDelay));
            }
        }
    }
    throw lastError || new Error("Failed to fetch from Arbus API after retries");
}

/**
 * Creates and configures an ACP service provider for providing services
 */
export async function initializeACPServiceProvider(twitterConfig: TwitterConfig): Promise<any> {
    if (!twitterConfig.VIRTUALS_ACP_SELLER_WALLET_ADDRESS) {
        elizaLogger.error("[Virtuals ACP] VIRTUALS_ACP_SELLER_WALLET_ADDRESS is not set");
        return null;
    }
    if (!twitterConfig.VIRTUALS_ACP_SELLER_ENTITY_ID) {
        elizaLogger.error("[Virtuals ACP] VIRTUALS_ACP_SELLER_ENTITY_ID is not set");
        return null;
    }
    if (!twitterConfig.VIRTUALS_ACP_SELLER_PRIVATE_KEY) {
        elizaLogger.error("[Virtuals ACP] VIRTUALS_ACP_SELLER_PRIVATE_KEY is not set");
        return null;
    }
    if (!twitterConfig.ARBUS_API_KEY) {
        elizaLogger.error("[Virtuals ACP] ARBUS_API_KEY is not set");
        return null;
    }

    try {
        // Dynamic import to avoid constructor issues
        const AcpModule = await import("@virtuals-protocol/acp-node");

        // Try all possible locations for the class
        const AcpClient = (AcpModule as any).default?.default || (AcpModule as any).default || (AcpModule as any).AcpClient;
        const { AcpContractClient, AcpJobPhases, baseAcpConfig } = AcpModule;

        const sellerClient = new AcpClient({
            acpContractClient: await AcpContractClient.build(
                twitterConfig.VIRTUALS_ACP_SELLER_PRIVATE_KEY as Address,
                twitterConfig.VIRTUALS_ACP_SELLER_ENTITY_ID,
                twitterConfig.VIRTUALS_ACP_SELLER_WALLET_ADDRESS as Address,
                baseAcpConfig,
            ),
            onNewTask: async (job: any, memoToSign?: any) => {
                elizaLogger.log("[Virtuals ACP] New task received:", String(job.id));

                // Handle job request phase - respond to incoming job requests
                if (
                    job.phase === AcpJobPhases.REQUEST &&
                    memoToSign?.nextPhase === AcpJobPhases.NEGOTIATION
                ) {
                    elizaLogger.log("[Virtuals ACP] Responding to job", String(job.id));
                    try {
                        await job.respond(true);
                        elizaLogger.log(`[Virtuals ACP] Job ${String(job.id)} responded successfully`);
                    } catch (error) {
                        elizaLogger.error(`[Virtuals ACP] Error responding to job ${String(job.id)}:`, error);
                    }
                } 
                // Handle transaction phase - deliver the service
                else if (
                    job.phase === AcpJobPhases.TRANSACTION &&
                    memoToSign?.nextPhase === AcpJobPhases.EVALUATION
                ) {
                    elizaLogger.log("[Virtuals ACP] Delivering job", String(job.id));
                    let serviceResult: any;
                    try {
                        // Randomly pick one of two preset queries for the API
                        const queries = [
                            "what are the most promising project launches in gamefi that i should be looking out for in the upcoming months?",
                            "what are some of the latest news or insights in the web3 gaming or gamefi space?"
                        ];
                        const query = queries[Math.floor(Math.random() * queries.length)];
                        const arbusData = await fetchArbusApi(twitterConfig.ARBUS_API_KEY, query);
                        serviceResult = ({
                            content: arbusData.response,
                            timestamp: arbusData.timestamp || new Date().toISOString(),
                        });
                        elizaLogger.debug(`[Virtuals ACP] Got Arbus API response for job ${String(job.id)}:`, arbusData.response);
                    } catch (apiError) {
                        elizaLogger.error(`[Virtuals ACP] Error fetching Arbus API for job ${String(job.id)}:`, apiError);
                    }
                    if (serviceResult) {
                        try {
                            await job.deliver(serviceResult);
                            elizaLogger.log(`[Virtuals ACP] Job ${String(job.id)} delivered successfully`);
                        } catch (deliverError) {
                            elizaLogger.error(`[Virtuals ACP] Error delivering job ${String(job.id)}:`, deliverError);
                        }
                    } else {
                        elizaLogger.error(`[Virtuals ACP] Failed to get Arbus API response for job ${String(job.id)}. Not delivering job.`);
                    }
                }
            },
        });

        elizaLogger.log("[Virtuals ACP] Seller client created successfully");
        return sellerClient;
    } catch (error) {
        elizaLogger.error("[Virtuals ACP] Error creating seller client:", error);
        if (error instanceof Error) {
            elizaLogger.error("[Virtuals ACP] Error name:", error.name);
            elizaLogger.error("[Virtuals ACP] Error message:", error.message);
            elizaLogger.error("[Virtuals ACP] Error stack:", error.stack);
        }
        return null;
    }
}
