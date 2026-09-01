process.env.JWT_SECRET='t';
const { validateRow } = require('../routes/students').__test;
const { topperBelongsToCycle, labelNumber } = require('../routes/cycles').__test;
const { countsForAttendance } = require('../routes/logs').__test;
const CycleMark = require('../models/CycleMark');

let pass=0, fail=0;
const ok=(n,c,x='')=>{ c?(pass++,console.log('  PASS',n)):(fail++,console.log('  FAIL',n,x)); };

console.log('\nImport row validation');
ok('good row accepted', validateRow({roll:'124258090001',name:'Hardik Mishra'}).ok);
ok('name is trimmed and collapsed',
   validateRow({name:'HARDIK   MISHRA '}).doc.name === 'HARDIK MISHRA');
ok('missing name rejected', validateRow({roll:'123',name:'  '}).reason === 'no name');
ok('header row rejected', validateRow({name:'Student Name'}).reason === 'looks like a header row');
ok('roll with a space rejected', /unusual characters/.test(validateRow({roll:'1242 58090009',name:'X'}).reason));
ok('roll with slash accepted', validateRow({roll:'2503840100001/A',name:'X'}).ok);
ok('empty roll allowed', validateRow({roll:'',name:'No Roll Student'}).ok);
ok('33-char roll rejected', !validateRow({roll:'1'.repeat(33),name:'X'}).ok);
ok('section carried through', validateRow({roll:'1',name:'X',section:' B '}).doc.section === 'B');

console.log('\nTopper → cycle matching (the Cycle 1 vs Cycle 11 bug)');
ok('label number parsed', labelNumber('Cycle 11') === 11);
ok('Cycle 1 matches "Cycle 1"',   topperBelongsToCycle('Cycle 1', 1) === true);
ok('Cycle 1 does NOT match "Cycle 11"', topperBelongsToCycle('Cycle 11', 1) === false);
ok('Cycle 1 does NOT match "Cycle 10"', topperBelongsToCycle('Cycle 10', 1) === false);
ok('Cycle 2 does NOT match "Cycle 12"', topperBelongsToCycle('Cycle 12', 2) === false);
ok('Cycle 11 matches "Cycle 11"', topperBelongsToCycle('Cycle 11', 11) === true);
ok('unlabelled legacy topper still matches', topperBelongsToCycle('', 3) === true);
ok('non-numeric label still matches', topperBelongsToCycle('Final project', 3) === true);

console.log('\nWhich sessions count towards attendance');
ok('log with attendance counts', countsForAttendance({attendanceTaken:true, attendance:[{}]}) === true);
ok('legacy log with entries counts', countsForAttendance({attendance:[{}]}) === true);
ok('log with no roll call does NOT count', countsForAttendance({attendanceTaken:false, attendance:[]}) === false);

console.log('\nCategory thresholds (unchanged rules, re-checked)');
ok('150/200 = excellent', CycleMark.categoryFromMarks(80,70) === 'excellent');
ok('150/200 boundary 75% = excellent', CycleMark.categoryFromMarks(75,75) === 'excellent');
ok('100/200 = 50% = moderate', CycleMark.categoryFromMarks(50,50) === 'moderate');
ok('98/200 = 49% = basic', CycleMark.categoryFromMarks(49,49) === 'basic');
ok('0 = zero', CycleMark.categoryFromMarks(0,0) === 'zero');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
