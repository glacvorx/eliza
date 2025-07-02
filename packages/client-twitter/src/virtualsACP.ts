import { elizaLogger, IAgentRuntime, stringToUuid, generateText, ModelClass, composeContext } from "@elizaos/core";
import { TwitterConfig } from "./environment";
import { Address } from '@aa-sdk/core';
import { Tweet } from "agent-twitter-client";

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

async function buyACPService(twitterConfig: TwitterConfig, agentFilterKeyword: string, jobRequirement: string, runtime: IAgentRuntime): Promise<{ acpClient: any; jobId: string | null; AcpJobPhases: any; sellerResponse: string }> {
    if (!twitterConfig.VIRTUALS_ACP_BUYER_WALLET_ADDRESS) {
        elizaLogger.error("[Virtuals ACP] VIRTUALS_ACP_WALLET_ADDRESS is not set");
        return { acpClient: null, jobId: null, AcpJobPhases: null, sellerResponse: "" };
    }
    if (!twitterConfig.VIRTUALS_ACP_BUYER_ENTITY_ID) {
        elizaLogger.error("[Virtuals ACP] VIRTUALS_ACP_ENTITY_ID is not set");
        return { acpClient: null, jobId: null, AcpJobPhases: null, sellerResponse: "" };
    }
    if (!twitterConfig.VIRTUALS_ACP_BUYER_PRIVATE_KEY) {
        elizaLogger.error("[Virtuals ACP] VIRTUALS_ACP_BUYER_PRIVATE_KEY is not set");
        return { acpClient: null, jobId: null, AcpJobPhases: null, sellerResponse: "" };
    }

    let sellerResponse: string | undefined;

    try {
        // Dynamic import to avoid constructor issues
        const AcpModule = await import("@virtuals-protocol/acp-node");

        // Try all possible locations for the class
        const AcpClient = (AcpModule as any).default?.default || (AcpModule as any).default || (AcpModule as any).AcpClient;
        const { AcpContractClient, AcpJobPhases, baseAcpConfig, AcpAgentSort } = AcpModule;

        const acpClient = new AcpClient({
            acpContractClient: await AcpContractClient.build(
                twitterConfig.VIRTUALS_ACP_BUYER_PRIVATE_KEY as Address,
                twitterConfig.VIRTUALS_ACP_BUYER_ENTITY_ID,
                twitterConfig.VIRTUALS_ACP_BUYER_WALLET_ADDRESS as Address,
                baseAcpConfig,
            ),
            onNewTask: async (job: any) => {
                elizaLogger.log("[Virtuals ACP] New task received:", job.id);
                if (
                    job.phase === AcpJobPhases.NEGOTIATION &&
                    job.memos.find((m: any) => m.nextPhase === AcpJobPhases.TRANSACTION)
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

        // Browse available agents based on a keyword and cluster name
        try {
            elizaLogger.debug("[Virtuals ACP] Browsing agents...");
            const relevantAgents = await acpClient.browseAgents(
                agentFilterKeyword,
                "",
                [AcpAgentSort.SUCCESSFUL_JOB_COUNT, AcpAgentSort.IS_ONLINE],
                true,
                5
            );
            if (relevantAgents.length === 0) {
                elizaLogger.warn("[Virtuals ACP] No relevant agents found");
                return { acpClient: null, jobId: null, AcpJobPhases: null, sellerResponse: "" };
            }
            const chosenAgent = relevantAgents[0];
            elizaLogger.debug("[Virtuals ACP] Chosen agent:", chosenAgent.name);
            if (!chosenAgent.offerings || chosenAgent.offerings.length === 0) {
                elizaLogger.warn("[Virtuals ACP] No offerings available for chosen agent");
                return { acpClient: null, jobId: null, AcpJobPhases: null, sellerResponse: "" };
            }
            const chosenJobOffering = chosenAgent.offerings[0];
            elizaLogger.debug("[Virtuals ACP] Chosen job offering:", chosenJobOffering.type);

            // Generate the job requirement object based on the agent's schema
            let jobRequirementObject: any;
            try {
                jobRequirementObject = await generateJobRequirementObject(jobRequirement, chosenJobOffering, runtime);
                elizaLogger.debug("[Virtuals ACP] Generated job requirement object:", jobRequirementObject);
            } catch (error) {
                elizaLogger.error("[Virtuals ACP] Failed to generate job requirement object:", error);
                return { 
                    acpClient: null, 
                    jobId: null, 
                    AcpJobPhases: null, 
                    sellerResponse: `Error: ${error.message}. Please provide more specific information in your request.` 
                };
            }

            let jobId: any;
            try {
                jobId = await chosenJobOffering.initiateJob(
                    jobRequirementObject,
                    twitterConfig.VIRTUALS_ACP_BUYER_WALLET_ADDRESS as Address,// Use default evaluator address
                    new Date(Date.now() + 1000 * 60 * 60 * 24), // expiredAt as last parameter
                );
            } catch (error) {
                elizaLogger.error("[Virtuals ACP] Error initiating job:", error);
                if (error instanceof Error && error.message.includes("data must have required property")) {
                    // This is a schema validation error
                    const errorMessage = `Schema validation failed: ${error.message}. Please check the job requirement format.`;
                    elizaLogger.error("[Virtuals ACP]", errorMessage);
                    return { 
                        acpClient: null, 
                        jobId: null, 
                        AcpJobPhases: null, 
                        sellerResponse: `Error: ${errorMessage}` 
                    };
                } else {
                    // Other types of errors
                    return { 
                        acpClient: null, 
                        jobId: null, 
                        AcpJobPhases: null, 
                        sellerResponse: `Error initiating ACP job: ${error instanceof Error ? error.message : 'Unknown error'}` 
                    };
                }
            }

            elizaLogger.log(`[Virtuals ACP] Job ${jobId} initiated successfully`);
            return { acpClient, jobId, AcpJobPhases, sellerResponse };
        } catch (error) {
            elizaLogger.error("[Virtuals ACP] Error during agent browsing or job initiation:", error);
            if (error instanceof Error) {
                elizaLogger.error("[Virtuals ACP] Operation error name:", error.name);
                elizaLogger.error("[Virtuals ACP] Operation error message:", error.message);
                elizaLogger.error("[Virtuals ACP] Operation error stack:", error.stack);
            }
            return { acpClient: null, jobId: null, AcpJobPhases: null, sellerResponse: "" };
        }
    } catch (error) {
        elizaLogger.error("[Virtuals ACP] Error creating ACP Client:", error);
        if (error instanceof Error) {
            elizaLogger.error("[Virtuals ACP] Error name:", error.name);
            elizaLogger.error("[Virtuals ACP] Error message:", error.message);
            elizaLogger.error("[Virtuals ACP] Error stack:", error.stack);
        }
        return { acpClient: null, jobId: null, AcpJobPhases: null, sellerResponse: "" };
    }
}

/**
 * Check for delayed seller responses for a given job ID using existing AcpClient
 */
async function checkForSellerResponse(
    acpClient: any,
    jobId: string,
    AcpJobPhases: any
): Promise<string | null> {
    try {
        // Try to get job details to check for response
        try {
            const job = await acpClient.getJobById(jobId);
            if (job) {
                // Use the deliverable getter which automatically finds the COMPLETED memo
                const deliverable = job.deliverable;
                if (deliverable) {
                    elizaLogger.log(`[Virtuals ACP] Found delayed seller response for job ${jobId}:`, deliverable);
                    return deliverable;
                }
                
                // Check if job is completed - if so, return success response even if no deliverable
                if (job.phase === AcpJobPhases.COMPLETED) {
                    elizaLogger.log(`[Virtuals ACP] Job ${jobId} is completed with success response`);
                    return "Job completed successfully. No additional data provided.";
                } else {
                    elizaLogger.debug(`[Virtuals ACP] Job ${jobId} current phase: ${job.phase}`);
                }
            } else {
                elizaLogger.debug(`[Virtuals ACP] Job ${jobId} not found`);
            }
        } catch (error) {
            elizaLogger.debug(`[Virtuals ACP] Could not retrieve job ${jobId} for response check:`, error);
        }

        return null;
    } catch (error) {
        elizaLogger.error(`[Virtuals ACP] Error checking for seller response for job ${jobId}:`, error);
        return null;
    }
}

/**
 * Monitor ACP service response with retries using existing AcpClient
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
            
            const response = await checkForSellerResponse(acpClient, jobId, AcpJobPhases);
            
            if (response) {
                elizaLogger.log(`[Virtuals ACP] Seller response found on attempt ${attempt}:`, response);
                return response;
            }
            
            // Check if job is still in progress
            try {
                const job = await acpClient.getJobById(jobId);
                if (job) {
                    if (job.phase === AcpJobPhases.COMPLETED) {
                        // Job is completed but no deliverable found - return success response
                        elizaLogger.log(`[Virtuals ACP] Job ${jobId} completed with success response on attempt ${attempt}`);
                        return "Job completed successfully. No additional data provided.";
                    } else if (job.phase === AcpJobPhases.FAILED) {
                        elizaLogger.log(`[Virtuals ACP] Job ${jobId} failed on attempt ${attempt}`);
                        return "Job failed. Please try again or contact support.";
                    } else {
                        elizaLogger.debug(`[Virtuals ACP] Job ${jobId} still in progress, phase: ${job.phase}`);
                    }
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

export async function processVirtualsACP(
    runtime: IAgentRuntime,
    twitterUsername: string,
    tweet: Tweet,
    formattedConversation: string,
    imageDescriptions: string[] = [],
    quotedContent: string = "",
    twitterConfig: TwitterConfig
): Promise<string> {
    let sellerResponse = "";
    
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

        // 2. Determine if we should use ACP service
        const shouldUseACP = await shouldUseACPService(runtime, initialState);

        if (shouldUseACP.useACP) {
            // Get the tweet text from the tweet object
            const tweetText = tweet.text || '';

            if (tweetText) {
                elizaLogger.log(`[Virtuals ACP] Processing ACP service for tweet from @${tweet.username}`);
                elizaLogger.log(`[Virtuals ACP] Tweet content: "${tweetText.substring(0, 50)}..."`);

                // 3. Buy ACP service
                const { acpClient, jobId, AcpJobPhases, sellerResponse: immediateResponse } = await buyACPService(twitterConfig, shouldUseACP.keyword!, shouldUseACP.requirement!, runtime);

                if (jobId) {
                    // 4. Check for delayed seller response if no immediate response
                    let finalSellerResponse = immediateResponse;
                    if (!immediateResponse) {
                        elizaLogger.log(`[Virtuals ACP] No immediate seller response, checking for delayed response for job ${jobId}`);
                        // Use monitoring with shorter retry for immediate check
                        finalSellerResponse = await monitorACPServiceResponse(acpClient, jobId, AcpJobPhases);
                    }

                    // 5. Format the result for Twitter
                    let resultText = `ACP job initiated successfully! Job ID: ${jobId}\n\nTask: ${shouldUseACP.requirement}\n\nAgent keyword: ${shouldUseACP.keyword}`;
                    
                    // Add seller response - jobs will always have a response (either success or data)
                    if (finalSellerResponse) {
                        resultText += `\n\nSeller Response:\n${finalSellerResponse}`;
                        elizaLogger.log('[Virtuals ACP] Including seller response in result');
                    } else {
                        // If no response found yet, indicate that response is pending
                        resultText += `\n\nStatus: Job is in progress. Response will be available once the job is completed.`;
                        elizaLogger.log('[Virtuals ACP] Job response is still pending');
                    }
                    
                    sellerResponse = resultText;

                    // Log successful service initiation
                    elizaLogger.log('[Virtuals ACP] Successfully initiated ACP job', {
                        tweetId: tweet.id,
                        username: tweet.username,
                        jobId: jobId,
                        keyword: shouldUseACP.keyword,
                        requirementLength: shouldUseACP.requirement!.length,
                        hasSellerResponse: !!finalSellerResponse,
                        responseType: immediateResponse ? 'immediate' : finalSellerResponse ? 'delayed' : 'pending'
                    });
                } else {
                    elizaLogger.log('[Virtuals ACP] Failed to initiate ACP job');
                    sellerResponse = "Could not initiate ACP job: No suitable agents found or service unavailable.";
                }
            } else {
                elizaLogger.warn('[Virtuals ACP] Tweet has no text content');
                sellerResponse = "Error: Tweet has no text content for ACP processing.";
            }
        } else {
            elizaLogger.log('[Virtuals ACP] Decision: Not using ACP job for this tweet');
            sellerResponse = ""; // Return empty string when not using ACP
        }
    } catch (error) {
        elizaLogger.error(`[Virtuals ACP] Error in ACP job processing: ${error}`, error);
        sellerResponse = `Error processing ACP job: ${error}`;
    }

    return sellerResponse;
}
