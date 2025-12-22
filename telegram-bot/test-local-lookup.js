import { loadBinDatabase, lookupBinLocal } from './utils.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CSV_PATH = path.join(__dirname, '..', 'bin-list-data.csv');

async function test() {
    console.log('--- Testing Local BIN Lookup ---');
    const success = await loadBinDatabase(CSV_PATH);
    if (!success) {
        console.error('Failed to load database. Exiting.');
        return;
    }

    // Test Case 1: Known BIN from CSV (first few lines)
    // 002102,"PRIVATE LABEL",CREDIT,STANDARD,"CHINA MERCHANTS BANK",...
    const bin1 = '002102';
    console.log(`\nTesting BIN: ${bin1}`);
    const result1 = lookupBinLocal(bin1);
    console.log('Result:', result1);

    if (result1 && result1.bank === 'CHINA MERCHANTS BANK') {
        console.log('✅ Test Case 1 Passed');
    } else {
        console.error('❌ Test Case 1 Failed');
    }

    // Test Case 2: Random BIN likely not in DB
    const bin2 = '123456789';
    console.log(`\nTesting Random BIN: ${bin2}`);
    const result2 = lookupBinLocal(bin2);
    console.log('Result:', result2);

    if (result2 === null) {
        console.log('✅ Test Case 2 Passed (Correctly returned null)');
    } else {
        console.warn('⚠️ Test Case 2 returned data (maybe it exists?)');
    }
}

test();
