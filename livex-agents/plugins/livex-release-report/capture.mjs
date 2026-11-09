import { parseArgs } from "node:util";
import { collectCloudRunServingImages } from "./read-cloud-run-serving-images.mjs";

const usage = "Usage: node capture.mjs [--service <id>] [--environment dev|stg|prd]";

export async function runCapture(
  args,
  { output = console.log, error = console.error } = {},
  readers = undefined,
) {
  try {
    const { values } = parseArgs({
      args,
      options: {
        service: { type: "string" },
        environment: { type: "string" },
        help: { type: "boolean" },
      },
    });
    if (values.help) {
      output(usage);
      return 0;
    }
    const result = await collectCloudRunServingImages(values, readers);
    output(JSON.stringify(result, null, 2));
    return 0;
  } catch (cause) {
    if (cause instanceof RangeError || cause?.code?.startsWith("ERR_PARSE_ARGS_")) {
      error("Invalid capture options. " + usage);
      return 2;
    }
    error("Cloud Run capture failed.");
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runCapture(process.argv.slice(2));
}
