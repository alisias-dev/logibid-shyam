import express from 'express';
import { GoogleGenAI, Type } from '@google/genai';
import { queryPool } from './db_pool';

const router = express.Router();

/**
 * Validation middleware ensuring GEMINI_API_KEY is present
 */
router.use((req, res, next) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey === 'your-gemini-api-key' || apiKey.trim() === '') {
    return res.status(500).json({ 
      error: 'GEMINI_API_KEY is not configured in the application environment.',
      details: 'Please configure your GEMINI_API_KEY in Vercel project environment variables or local .env file.'
    });
  }
  next();
});

/**
 * Lazy helper to initialize Gemini client safely.
 * Set User-Agent as 'aistudio-build' as required.
 */
function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY!;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

/**
 * Helper to build general platform context for Gemini system prompts
 */
async function getPlatformContext() {
  const transportersRes = await queryPool("SELECT count(*) FROM transporters WHERE status = 'ACTIVE'");
  const transporterCount = parseInt(transportersRes.rows[0].count, 10);

  const reqsRes = await queryPool('SELECT id, target_rate, status FROM requirements');
  const requirements = reqsRes.rows;

  const activeReqs = requirements.filter(r => r.status === 'LIVE').length;
  const awardedReqs = requirements.filter(r => r.status === 'AWARDED' || r.status === 'CLOSED').length;

  const bidsRes = await queryPool('SELECT requirement_id, amount FROM bids');
  const bids = bidsRes.rows;

  const awardsRes = await queryPool('SELECT requirement_id, amount FROM awards');
  const awards = awardsRes.rows;

  // Calculate simulated savings
  let totalSavings = 0;
  requirements.forEach(req => {
    if (req.targetRate) {
      const award = awards.find(a => a.requirementId === req.id);
      if (award) {
        totalSavings += Math.max(0, Number(req.targetRate) - Number(award.amount));
      } else {
        const reqBids = bids.filter(b => b.requirementId === req.id);
        if (reqBids.length > 0) {
          const lowestBid = Math.min(...reqBids.map(b => Number(b.amount)));
          totalSavings += Math.max(0, Number(req.targetRate) - lowestBid);
        }
      }
    }
  });

  return {
    transporterCount,
    requirementsCount: requirements.length,
    activeReqs,
    awardedReqs,
    totalSavings,
  };
}

/**
 * POST /api/ai/chat
 * General logistics copilot assistant chat endpoint
 */
router.post('/chat', async (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages array is required.' });
  }

  try {
    const ai = getGeminiClient();
    const stats = await getPlatformContext();
    
    // Fetch active transporters for AI prompt context using snake_case columns
    const transportersRes = await queryPool('SELECT company_name, vehicle_types, operating_states FROM transporters WHERE status = $1', ['ACTIVE']);
    const transportersList = transportersRes.rows;

    const formattedContents = messages.map((m: any) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const systemInstruction = `You are LogiBid Copilot, an expert enterprise logistics AI advisor. 
You help logistics managers and transporters negotiate, predict market rates, match trucks, and optimize procurement.
Here is the real-time context of the LogiBid platform:
- Onboarded Active Transporters: ${stats.transporterCount}
- Total Freight Requirements: ${stats.requirementsCount} (${stats.activeReqs} currently LIVE and bidding)
- Total Procured/Awarded Requirements: ${stats.awardedReqs}
- Est. Procurement Savings realized on platform: ₹${stats.totalSavings.toLocaleString('en-IN')}

Active Onboarded Transporters list:
${transportersList.map(t => `- ${t.companyName} (Vehicles: ${(t.vehicleTypes || []).join(', ')}, States: ${(t.operatingStates || []).join(', ')})`).join('\n')}

Always provide highly professional, concise, actionable, and data-driven responses. Be specific, and structure long answers with clear headings or bullet points where appropriate. Keep responses engaging and clean. Avoid technical developer jargon.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: formattedContents,
      config: {
        systemInstruction,
      },
    });

    return res.json({ text: response.text });
  } catch (error: any) {
    console.error('Gemini chat error:', error);
    return res.status(500).json({ 
      error: 'AI is temporarily unavailable.', 
      details: error.message 
    });
  }
});

/**
 * POST /api/ai/predict-rate
 * Specialized AI route rate predictor with structured JSON response
 */
router.post('/predict-rate', async (req, res) => {
  const { pickup, delivery, vehicleType, weight, material } = req.body;

  if (!pickup || !delivery || !vehicleType) {
    return res.status(400).json({ error: 'Pickup, delivery, and vehicleType are required.' });
  }

  try {
    const ai = getGeminiClient();
    const prompt = `Predict logistics market rates and provide strategy for:
- Pickup: ${pickup}
- Delivery: ${delivery}
- Vehicle Type: ${vehicleType}
- Weight: ${weight ? `${weight} Tons` : 'Standard'}
- Material: ${material || 'General Cargo'}

Analyze historical and realistic Indian logistics parameters to supply pricing guidance in INR.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          required: [
            'predictedMinRate',
            'predictedMaxRate',
            'recommendedTargetRate',
            'confidenceScore',
            'marketFactors',
            'routeDifficulty',
            'strategicAdvice',
          ],
          properties: {
            predictedMinRate: {
              type: Type.INTEGER,
              description: 'Minimum expected market bid amount in INR for this haul.',
            },
            predictedMaxRate: {
              type: Type.INTEGER,
              description: 'Maximum expected market bid amount in INR for this haul.',
            },
            recommendedTargetRate: {
              type: Type.INTEGER,
              description: 'Optimal target rate to set in the requirement (in INR) to stimulate aggressive bidding.',
            },
            confidenceScore: {
              type: Type.INTEGER,
              description: 'Percentage level (0-100) of confidence in this prediction.',
            },
            marketFactors: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'List of 3 specific factors (fuel, season, tolls, demand) affecting this route.',
            },
            routeDifficulty: {
              type: Type.STRING,
              description: 'Short description of terrain/route difficulty.',
            },
            strategicAdvice: {
              type: Type.STRING,
              description: 'Specific recommendation on how to run this bidding round successfully.',
            },
          },
        },
      },
    });

    const data = JSON.parse(response.text?.trim() || '{}');
    return res.json(data);
  } catch (error: any) {
    console.error('Gemini rate prediction error:', error);
    return res.status(500).json({ 
      error: 'Failed to predict rates.', 
      details: error.message 
    });
  }
});

/**
 * POST /api/ai/match-transporters
 * Suggest matching transporters based on operational profile
 */
router.post('/match-transporters', async (req, res) => {
  const { requirementId } = req.body;

  if (!requirementId) {
    return res.status(400).json({ error: 'Requirement ID is required.' });
  }

  try {
    const ai = getGeminiClient();
    const reqRes = await queryPool('SELECT * FROM requirements WHERE id = $1', [requirementId]);
    const requirement = reqRes.rows[0];

    if (!requirement) {
      return res.status(404).json({ error: 'Requirement not found.' });
    }

    const transportersRes = await queryPool('SELECT id, company_name, preferred_routes, operating_states, vehicle_types FROM transporters WHERE status = $1', ['ACTIVE']);
    const transportersContext = transportersRes.rows.map(t => ({
      id: t.id,
      companyName: t.companyName,
      preferredRoutes: t.preferredRoutes,
      operatingStates: t.operatingStates,
      vehicleTypes: t.vehicleTypes,
    }));

    const prompt = `Analyze matching transporters for this requirement:
Requirement:
- Pickup: ${requirement.pickupLocation}
- Delivery: ${requirement.deliveryLocation}
- Vehicle Type: ${requirement.vehicleType}
- Weight: ${requirement.weight} Tons
- Material: ${requirement.material}

Transporters List to Match Against:
${JSON.stringify(transportersContext, null, 2)}

Produce a ranked matching list. Each match must contain a percentage match score (0-100), logical matching reasons, potential risk factors, and a personalized WhatsApp/email invitation draft template.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          required: ['matches'],
          properties: {
            matches: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ['transporterId', 'companyName', 'matchScore', 'matchReasons', 'riskFactors', 'draftOutreachMessage'],
                properties: {
                  transporterId: { type: Type.STRING },
                  companyName: { type: Type.STRING },
                  matchScore: { type: Type.INTEGER },
                  matchReasons: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: 'Specific points explaining why they fit well (e.g., operates in state, has correct fleet).',
                  },
                  riskFactors: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: 'Possible downsides or items to verify (e.g. state regulatory permits, rate history).',
                  },
                  draftOutreachMessage: { 
                    type: Type.STRING,
                    description: 'Personalized professional invitation draft message referencing the specific load.',
                  },
                },
              },
            },
          },
        },
      },
    });

    const data = JSON.parse(response.text?.trim() || '{}');
    return res.json(data);
  } catch (error: any) {
    console.error('Gemini transporter match error:', error);
    return res.status(500).json({ 
      error: 'Failed to generate matches.', 
      details: error.message 
    });
  }
});

/**
 * POST /api/ai/negotiator
 * Draft supplier negotiation messaging templates
 */
router.post('/negotiator', async (req, res) => {
  const { requirementId } = req.body;

  if (!requirementId) {
    return res.status(400).json({ error: 'Requirement ID is required.' });
  }

  try {
    const ai = getGeminiClient();
    const reqRes = await queryPool('SELECT * FROM requirements WHERE id = $1', [requirementId]);
    const requirement = reqRes.rows[0];

    if (!requirement) {
      return res.status(404).json({ error: 'Requirement not found.' });
    }

    // Load active bids
    const bidsRes = await queryPool('SELECT * FROM bids WHERE requirement_id = $1', [requirementId]);
    const reqBids = bidsRes.rows;
    if (reqBids.length === 0) {
      return res.status(400).json({ error: 'No active transporter bids found to negotiate against.' });
    }

    // Build ranking context
    const bidRanks: any[] = [];
    for (const b of reqBids) {
      const transRes = await queryPool('SELECT company_name FROM transporters WHERE id = $1', [b.transporterId]);
      const trans = transRes.rows[0];
      bidRanks.push({
        transporterId: b.transporterId,
        companyName: trans ? trans.companyName : 'Unknown Transporter',
        amount: Number(b.amount),
      });
    }
    bidRanks.sort((a, b) => a.amount - b.amount);

    const lowestBidAmount = bidRanks[0].amount;
    const targetRate = requirement.targetRate ? Number(requirement.targetRate) : Math.round(lowestBidAmount * 0.95);

    const prompt = `Generate expert negotiation strategies and drafted message templates for these bids:
Requirement: ${requirement.pickupLocation} to ${requirement.deliveryLocation} (${requirement.vehicleType}, Target Rate: ₹${targetRate})
Lowest Active Bid: ₹${lowestBidAmount}

Bidders List:
${JSON.stringify(bidRanks, null, 2)}

Provide a structured list of custom negotiation drafts. Offer L1 bidder a volume discount message, L2/L3 bidders a message to match L1 or target, and general tactical advice.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          required: ['tacticalTips', 'negotiations'],
          properties: {
            tacticalTips: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'General expert negotiation recommendations for this scenario.',
            },
            negotiations: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ['transporterId', 'companyName', 'currentBid', 'targetCounterOffer', 'draftMessage', 'strategyDescription'],
                properties: {
                  transporterId: { type: Type.STRING },
                  companyName: { type: Type.STRING },
                  currentBid: { type: Type.INTEGER },
                  targetCounterOffer: { type: Type.INTEGER },
                  strategyDescription: { type: Type.STRING, description: 'E.g., Volume guarantee, L1 match, reverse push.' },
                  draftMessage: { type: Type.STRING, description: 'Full ready-to-send draft message in polite, firm commercial language.' },
                },
              },
            },
          },
        },
      },
    });

    const data = JSON.parse(response.text?.trim() || '{}');
    return res.json(data);
  } catch (error: any) {
    console.error('Gemini negotiator error:', error);
    return res.status(500).json({ 
      error: 'Failed to generate negotiator strategies.', 
      details: error.message 
    });
  }
});

export default router;
