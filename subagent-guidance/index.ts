import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
const DEFAULT_GUIDANCE_FILENAME = "SUBAGENT_USE.md";
const SECTION_HEADER = "# Parent-Only Subagent Guidance";

function isSubagentChild(): boolean {
	return process.env[SUBAGENT_CHILD_ENV] === "1";
}

function loadGuidance(agentDir: string): string | null {
	const guidancePath = path.join(agentDir, DEFAULT_GUIDANCE_FILENAME);
	if (!fs.existsSync(guidancePath)) return null;

	try {
		const content = fs.readFileSync(guidancePath, "utf-8").trim();
		return content || null;
	} catch {
		return null;
	}
}

export default function subagentGuidance(pi: ExtensionAPI) {
	const agentDir = path.join(process.env.HOME || "", ".pi", "agent");

	pi.on("before_agent_start", async (event) => {
		if (isSubagentChild()) return;

		const guidance = loadGuidance(agentDir);
		if (!guidance) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${SECTION_HEADER}\n\n## ${path.join(agentDir, DEFAULT_GUIDANCE_FILENAME)}\n\n${guidance}`,
		};
	});
}
