// Extract only model-visible metadata from local TypeScript tool definitions.
// No tool execute function is evaluated or called.
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { Type } from 'typebox';
const root=path.resolve(process.argv[2] || '.');
const output=process.argv[3];
const order=['read','bash','edit','write','code_search','codegraph','subagent'];
const found=new Map();
for(const name of ['lib/engine/coding-tools.ts','lib/engine/deer-loop-composition.ts','lib/code-index/tool.ts','lib/codegraph/tools.ts','lib/parallel-agent/subagent-tool.ts']) {
  const source=await fs.readFile(path.join(root,name),'utf8').catch(error=>{ if(error.code==='ENOENT' && name==='lib/code-index/tool.ts')return null; throw error; });
  if(source===null)continue;
  const ast=ts.createSourceFile(name,source,ts.ScriptTarget.Latest,true);
  function visit(node) {
    if(ts.isCallExpression(node)&&node.expression.getText(ast)==='defineTool'&&ts.isObjectLiteralExpression(node.arguments[0])) {
      const props=node.arguments[0].properties.filter(p=>ts.isPropertyAssignment(p)&&['name','description','promptSnippet','parameters'].includes(p.name.getText(ast)));
      const expr=`({${props.map(p=>p.getText(ast)).join(',')}})`;
      const value=Function('Type','unrestricted','contextHint','CODEGRAPH_TOOL_NAME','SUBAGENT_TOOL_NAME','MAX_WORKERS_PER_RUN',`return ${expr}`)(Type,false,' Also readable: session context archive at /SESSION_CONTEXT (compacted history + spilled tool outputs).','codegraph','subagent',5);
      if(order.includes(value.name))found.set(value.name,value);
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);
}
const tools=order.map(n=>{if(!found.has(n))throw new Error(`Missing ${n}`);return found.get(n);});
const summary=tools.map(t=>`- ${t.promptSnippet}`).join('\n');
const parameters=tools.map(t=>t.parameters);
const modelTools=tools.map(({name,description,parameters})=>({name,description,parameters}));
const result={normalization:'Project mode, fixed context archive placeholder; schema structure included. Character counts are not tokens.',tools,summary,counts:{summaryChars:summary.length,descriptionChars:tools.reduce((n,t)=>n+t.description.length,0),parameterSchemaChars:JSON.stringify(parameters).length,modelToolsChars:JSON.stringify(modelTools).length}};
if(output)await fs.writeFile(output,JSON.stringify(result,null,2));
console.log(JSON.stringify(result.counts));
