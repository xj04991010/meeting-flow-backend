const fs = require('fs');
const path = './src/services/message-handler.service.ts';
const lines = fs.readFileSync(path, 'utf8').split('\n');

function findLine(substr, start = 0) {
    for (let i = start; i < lines.length; i++) {
        if (lines[i].includes(substr)) return i + 1;
    }
    return -1;
}

console.log("IntentOutput start: ", findLine("interface IntentOutput {"));
console.log("routeIntent start: ", findLine("export async function routeIntent"));
console.log("routeIntent end: ", findLine("} catch (e) {", findLine("export async function routeIntent")) + 3);

console.log("query_schedule start: ", findLine("if (route.intent === 'query_schedule') {", 500));
console.log("chit_chat start: ", findLine("if (route.intent === 'chit_chat'", 500));
console.log("query_weather start: ", findLine("if (route.intent === 'query_weather')", 500));
console.log("update_tasks start: ", findLine("if (route.intent === 'update_tasks')", 500));
console.log("supplement start: ", findLine("if (route.intent === 'supplement')", 500));
console.log("handleResearchCommand start: ", findLine("async function handleResearchCommand"));
