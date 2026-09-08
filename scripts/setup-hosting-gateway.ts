import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runGatewaySetup } from '../apps/public-gateway/src/setup.js';
export {
  setupHostingGateway,
  setupHostingGatewayCommand,
} from '../apps/public-gateway/src/setup.js';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await runGatewaySetup(process.argv.slice(2));
