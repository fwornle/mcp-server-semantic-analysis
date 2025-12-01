const fs = require('fs');
const path = require('path');

console.log('🔍 Checking for phantom nodes...');

const memoryPath = './.data/knowledge-export/coding.json';
const memory = JSON.parse(fs.readFileSync(memoryPath, 'utf8'));

console.log('Total entities:', memory.entities.length);

let phantomCount = 0;
let validCount = 0;

memory.entities.forEach(entity => {
  const insightPath = path.join('./knowledge-management/insights', `${entity.name}.md`);
  const exists = fs.existsSync(insightPath);
  
  if (!exists) {
    console.log('❌ PHANTOM NODE DETECTED:', entity.name, '- file missing at', insightPath);
    phantomCount++;
  } else {
    console.log('✅ Valid entity:', entity.name);
    validCount++;
  }
});

console.log('\n📊 Summary:');
console.log('Valid entities:', validCount);
console.log('Phantom nodes:', phantomCount);
console.log('Total entities:', validCount + phantomCount);

if (phantomCount === 0) {
  console.log('🎉 SUCCESS: No phantom nodes detected!');
} else {
  console.log('⚠️  WARNING: Phantom nodes still exist!');
}