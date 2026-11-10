import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const gateway = process.env.AGENT_ROOM_GATEWAY_URL;
if (!gateway || !/^http:\/\/127\.0\.0\.1:\d+\/internal\/capabilities\/[a-f0-9]{64}$/.test(gateway)) throw Error('Missing scoped local capability gateway');
const response = await fetch(gateway);
if (!response.ok) throw Error('Capability session unavailable');
const { tools } = await response.json();
const server = new Server({ name: 'agent-room', version: '0.2.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const r = await fetch(gateway, { method:'POST', headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ tool:request.params.name, args:request.params.arguments || {} }) });
  if (!r.ok) return { isError:true, content:[{type:'text',text:'Capability request failed (' + r.status + ')'}] };
  return r.json();
});
await server.connect(new StdioServerTransport());
