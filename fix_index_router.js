const fs = require('fs');

const indexPath = './src/index.ts';
let indexContent = fs.readFileSync(indexPath, 'utf8');

indexContent = indexContent.replace(/routeIntent,/g, '');
indexContent = "import { routeIntent } from './services/intent-router.service';\n" + indexContent;

fs.writeFileSync(indexPath, indexContent, 'utf8');
