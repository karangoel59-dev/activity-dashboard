/**
 * Azure OpenAI chat helper shared by the features that summarise and classify work.
 */
import { env } from '$env/dynamic/private';

export function aiConfigured(): boolean {
	return Boolean(env.AZURE_OPENAI_ENDPOINT && env.AZURE_OPENAI_API_KEY);
}

// Reasoning models only accept their default temperature; once the deployment refuses one, stop sending it
let temperatureSupported = true;

/** Single-turn chat completion against the configured Azure OpenAI deployment. */
export async function chat(
	system: string,
	user: string,
	maxTokens = 250,
	{ json = false, temperature = 0.7 } = {}
): Promise<string> {
	const send = (withTemperature: boolean) =>
		fetch(env.AZURE_OPENAI_ENDPOINT as string, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'api-key': env.AZURE_OPENAI_API_KEY as string
			},
			body: JSON.stringify({
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: user }
				],
				// max_tokens is refused by newer models; this name works on all of them
				max_completion_tokens: maxTokens,
				...(withTemperature && { temperature }),
				...(json && { response_format: { type: 'json_object' } })
			})
		});

	// Requests run in parallel: retry based on what this one sent, not on the flag another may have flipped
	const sentTemperature = temperatureSupported;
	let response = await send(sentTemperature);
	if (response.status === 400 && sentTemperature) {
		const text = await response.text();
		if (!/"param":\s*"temperature"/.test(text)) throw new Error(`Azure OpenAI 400: ${text}`);
		temperatureSupported = false;
		response = await send(false);
	}
	if (!response.ok) throw new Error(`Azure OpenAI ${response.status}: ${await response.text()}`);

	const result = await response.json();
	return result.choices?.[0]?.message?.content?.trim() || '';
}
