// Keep the engine's Chat Completions-shaped interface while supporting Responses providers.
function responsesPayload(payload, route) {
	const request = {model:payload.model || route.model, store:false, input:payload.messages.map(message => ({
		role:message.role,
		content:typeof message.content === 'string' ? [{type:message.role === 'assistant' ? 'output_text' : 'input_text', text:message.content}]
			: message.content.map(part => {
				if (part.type === 'text') return {type:message.role === 'assistant' ? 'output_text' : 'input_text', text:part.text};
				if (part.type === 'image_url') return {type:'input_image', image_url:part.image_url.url, ...(part.image_url.detail ? {detail:part.image_url.detail} : {})};
				throw Error('Responses 控制器收到不支持的消息内容类型。');
			}),
	}))};
	const limit = payload.max_completion_tokens ?? payload.max_tokens;
	if (limit !== undefined) request.max_output_tokens = limit;
	const effort = payload.reasoning_effort === undefined ? route.reasoning_effort : payload.reasoning_effort;
	if (effort) request.reasoning = {effort};
	if (payload.response_format) {
		const format = payload.response_format;
		if (format.type === 'json_schema') request.text = {format:{type:'json_schema', ...format.json_schema}};
		else if (['json_object', 'text'].includes(format.type)) request.text = {format:{type:format.type}};
		else throw Error('Responses 控制器收到不支持的输出格式。');
	}
	for (const key of ['temperature', 'top_p']) if (payload[key] !== undefined) request[key] = payload[key];
	return request;
}
function chatResult(response) {
	if (response.error || !['completed', 'incomplete'].includes(response.status)) throw Error('Responses 控制器未完成请求。');
	const content = (response.output || []).filter(item => item.type === 'message').flatMap(item => item.content || []);
	if (content.some(item => item.type === 'refusal')) throw Error('Responses 控制器拒绝了请求。');
	if (response.status === 'incomplete' && response.incomplete_details?.reason !== 'max_output_tokens') throw Error('Responses 控制器返回了未完成结果。');
	const text = content.filter(item => item.type === 'output_text').map(item => item.text).join('') || response.output_text || '';
	if (!text && response.status === 'completed') throw Error('Responses 控制器未返回文字内容。');
	return {id:response.id, choices:[{message:{role:'assistant', content:text}, finish_reason:response.status === 'incomplete' ? 'length' : 'stop'}],
		usage:response.usage ? {prompt_tokens:response.usage.input_tokens, completion_tokens:response.usage.output_tokens, total_tokens:response.usage.total_tokens} : undefined};
}
function adaptController(client, route) {
	const original = client.chat.completions.create.bind(client.chat.completions);
	client.chat.completions.create = async (payload, options) => {
		if (route.wire_api === 'responses') return chatResult(await client.responses.create(responsesPayload(payload, route), options));
		const request = {...payload};
		if (request.reasoning_effort === null) delete request.reasoning_effort;
		else if (request.reasoning_effort === undefined && route.reasoning_effort) request.reasoning_effort = route.reasoning_effort;
		return original(request, options);
	};
	return client;
}
module.exports = {adaptController, responsesPayload, chatResult};
