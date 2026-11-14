import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildReport} from '../src/report.mjs';
const header='id,date,category,amount_czk,status\n';
test('trailing empty sixth column at EOF is rejected',()=>{
 assert.throws(()=>buildReport(header+'x,2026-01-01,food,1.00,posted,'),TypeError);
});
test('trailing empty sixth header field at EOF is rejected',()=>{
 assert.throws(()=>buildReport('id,date,category,amount_czk,status,'),TypeError);
});
test('category subtotal overflow cannot silently round cents',()=>{
 assert.throws(()=>buildReport(header+[
 'a,2026-01-01,A,90071992547409.91,posted',
 'b,2026-01-01,B,-90071992547409.91,posted',
 'c,2026-01-01,A,1.00,posted'].join('\n')),TypeError);
});
test('month subtotal overflow cannot hide behind another month refund',()=>{
 assert.throws(()=>buildReport(header+[
 'a,2026-01-01,A,90071992547409.91,posted',
 'b,2026-02-01,A,-90071992547409.91,posted',
 'c,2026-01-01,A,1.00,posted'].join('\n')),TypeError);
});
