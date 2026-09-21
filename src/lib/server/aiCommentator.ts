/**
 * Azure OpenAI chat helper shared by the features that summarise and classify work.
 */
import { env } from '$env/dynamic/private';

export function aiConfigured(): boolean {
	return Boolean(env.AZURE_OPENAI_ENDPOINT && env.AZURE_OPENAI_API_KEY);
}

/** Single-turn chat completion against the configured Azure OpenAI deployment. */
export async function chat(
	system: string,
	user: string,
	maxTokens = 250,
	{ json = false, temperature = 0.7 } = {}
): Promise<string> {
	const response = await fetch(env.AZURE_OPENAI_ENDPOINT as string, {
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
			max_tokens: maxTokens,
			temperature,
			...(json && { response_format: { type: 'json_object' } })
		})
	});
	if (!response.ok) throw new Error(`Azure OpenAI ${response.status}: ${await response.text()}`);

	const result = await response.json();
	return result.choices?.[0]?.message?.content?.trim() || '';
}
