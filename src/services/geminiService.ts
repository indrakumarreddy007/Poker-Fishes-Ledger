import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: (import.meta as any).env?.VITE_GEMINI_API_KEY || "" });

export interface ExtractedResult {
  name: string;
  amount: number;
}

export async function extractPokerResults(data: string, mimeType: string, isText: boolean = false): Promise<ExtractedResult[]> {
  const model = "gemini-1.5-flash";

  const prompt = `
    Extract player names and their corresponding profit/loss amounts from this poker session data.
    Look for names and numbers (positive for profit, negative for loss).
    Return the data as a clean JSON array of objects with 'name' and 'amount' properties.
    If a name looks like an alias or is misspelled, keep it as is; the user will correct it.
  `;

  const parts: any[] = [{ text: prompt }];

  if (isText) {
    parts.push({ text: data });
  } else {
    parts.push({
      inlineData: {
        mimeType: mimeType,
        data: data.split(",")[1] || data,
      },
    });
  }

  try {
    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          parts: parts,
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              amount: { type: Type.NUMBER },
            },
            required: ["name", "amount"],
          },
        },
      },
    });

    try {
      return JSON.parse(response.text || "[]");
    } catch (e) {
      console.error("Failed to parse Gemini response", e);
      throw new Error("AI returned invalid data format.");
    }
  } catch (apiError: any) {
    console.error("Gemini API Error details:", apiError);
    if (apiError?.message?.includes('API key')) {
      throw new Error("Invalid or missing API key.");
    }
    throw new Error(apiError?.message || "Failed to communicate with AI service.");
  }
}
