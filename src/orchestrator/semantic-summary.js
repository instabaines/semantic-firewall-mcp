import { listDatasets } from "../protected-resource/demo-db.js";
import { generateJsonWithModel } from "../inspector/model-client.js";

const INTENT_TYPES = ["report", "read", "export", "delete", "unknown"];

export function fallbackSummary(prompt, datasets) {
  const normalized = String(prompt || "").toLowerCase();
  const matched = datasets.filter((dataset) => {
    const id = dataset.id.toLowerCase();
    const name = dataset.name.toLowerCase();
    const reversed = name.split(/\s+/).reverse().join(" ");
    return [id, name, reversed].some((alias) => normalized.includes(alias));
  });

  let intentType = "read";
  if (normalized.includes("delete") || normalized.includes("remove")) {
    intentType = "delete";
  } else if (normalized.includes("export") || normalized.includes("email list") || normalized.includes("contact list")) {
    intentType = "export";
  } else if (normalized.includes("report") || normalized.includes("summary") || normalized.includes("summarize")) {
    intentType = "report";
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

  if (config.ollamaModel && config.summarizerMode !== "deterministic") {
    try {
      const parsed = await generateJsonWithModel({
        config,
        prompt: promptText,
        maxTokens: 220,
      });

      // The model may only select from the catalog; it cannot invent resource URIs.
      const known = new Set(datasets.map((dataset) => dataset.uri));
      const intentType = INTENT_TYPES.includes(parsed.intentType) ? parsed.intentType : "unknown";
      return {
        summary: parsed.summary || String(prompt || "").trim(),
        intentType,
        requestedResourceUris: Array.isArray(parsed.requestedResourceUris)
          ? parsed.requestedResourceUris.filter((uri) => known.has(uri))
          : [],
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
