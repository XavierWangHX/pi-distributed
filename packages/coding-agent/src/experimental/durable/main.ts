#!/usr/bin/env node

// Same CLI shape as the official pi: `pi [options] [message...]`, where -p/--print (or piped
// stdin/stdout) runs one headless round and prints the reply; without it, the TUI opens.
// The initial prompt is piped stdin plus the first message, like the official buildInitialMessage.
import { type OpenDurableOptions, openDurable } from "./runtime.ts";
import { runDurableTui } from "./tui.ts";

interface CliOptions extends OpenDurableOptions {
	readonly print: boolean;
	readonly messages: string[];
}

function parseArgs(argv: readonly string[]): CliOptions {
	let continueSession = false;
	let print = false;
	const messages: string[] = [];
	for (const arg of argv) {
		if (arg === "--continue" || arg === "-c") continueSession = true;
		else if (arg === "--print" || arg === "-p") print = true;
		else if (arg.startsWith("-")) throw new Error(`Unknown argument: ${arg}`);
		else messages.push(arg);
	}
	return { continueSession, print, messages };
}

/** Piped stdin content; undefined when stdin is a terminal. */
async function readPipedStdin(): Promise<string | undefined> {
	if (process.stdin.isTTY === true) return undefined;
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf8");
	return text === "" ? undefined : text;
}

const options = parseArgs(process.argv.slice(2));
const stdinContent = await readPipedStdin();
const initial = [stdinContent, options.messages[0]]
	.filter((part): part is string => part !== undefined)
	.join("");
// Official trigger: -p, or stdin/stdout not attached to a terminal.
const printMode = options.print || stdinContent !== undefined || process.stdout.isTTY === false;

const durable = await openDurable({ continueSession: options.continueSession });
try {
	if (!printMode) {
		await runDurableTui(durable.view, durable.controller, durable.settings);
	} else if (initial === "") {
		throw new Error("No prompt: pass a message, pipe stdin, or run without -p for the TUI.");
	} else {
		console.log(await durable.controller.ask(initial));
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	await durable.close();
}
