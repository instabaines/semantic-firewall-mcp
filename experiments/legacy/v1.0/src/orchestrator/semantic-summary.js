import { listDatasets } from "../protected-resource/demo-db.js";
import { generateJsonWithModel } from "../inspector/model-client.js";

function fallbackSummary(prompt, datasets) {
  const normalized = String(prompt || "").toLowerCase();
  const matched = datasets.filter((dataset) =>
    normalized.includes(dataset.id.toLowerCase()) ||
    normalized.includes(dataset.name.toLowerCase()),
  );

  let intentType = "read";
  if (normalized.includes("report") || normalized.includes("summary")) {
    intentType = "report";
  } else if (normalized.includes("delete") || normalized.includes("remove")) {
    intentType = "delete";
  } else if (normalized.includes("email") || normalized.includes("export")) {
    intentType = "export";
  }

  return {
    summary: String(prompt || "").trim().slice(0, 180) || "No intent provided.",
    intentType,
    requestedResourceUris: matched.map((dataset) => dataset.uri),
    rationale: "Fallback summarizer used deterministic keyword extraction.",
  };
}

export async function summarizeIntent({ config, prompt }) {
  const datasets = listDatasets(config);
  const datasetCatalog = datasets.map((dataset) => ({
    id: dataset.id,
    uri: dataset.uri,
    name: dataset.name,
    description: dataset.description,
  }));

  const promptText = `You are a security summarizer for a tool-using agent.
Return strict JSON with keys:
- summary: short plain-language summary of the user's original goal
- intentType: one of "report", "read", "export", "delete", "unknown"
- requestedResourceUris: array of dataset URIs explicitly relevant to the user's goal
- rationale: one sentence

Available datasets:
${JSON.stringify(datasetCatalog)}

User prompt:
${prompt}`;

  if (config.ollamaModel) {
    try {
      const parsed = await generateJsonWithModel({
        config,
        prompt: promptText,
        maxTokens: 220,
      });

      return {
        summary: parsed.summary || String(prompt || "").trim(),
        intentType: parsed.intentType || "unknown",
        requestedResourceUris: Array.isArray(parsed.requestedResourceUris) ? parsed.requestedResourceUris : [],
        rationale: parsed.rationale || "Model-derived semantic summary.",
      };
    } catch (error) {
      if (config.requireModel) {
        throw error;
      }
    }
  }

  return fallbackSummary(prompt, datasets);
}

export function deriveToolScopes(intentType) {
  if (intentType === "report") {
    return ["list_datasets", "get_dataset_overview", "read_dataset_rows", "generate_report"];
  }
  if (intentType === "read") {
    return ["list_datasets", "get_dataset_overview", "read_dataset_rows"];
  }
  if (intentType === "export") {
    return ["list_datasets", "get_dataset_overview", "export_customer_emails"];
  }
  if (intentType === "delete") {
    return ["list_datasets", "get_dataset_overview", "delete_dataset"];
  }
  return ["list_datasets"];
}
