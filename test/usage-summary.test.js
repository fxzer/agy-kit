const {test}=require('node:test');const assert=require('node:assert/strict');
const {summarize}=require('../src/usage-summary');
const days=dates=>dates.map(date=>({date,input:10,output:5,cache:2,cacheCreate:3,requests:1}));
test('连续天数跨年且遇到缺日重新计数',()=>{
 const rows=days(['2026-12-29','2026-12-30','2026-12-31','2027-01-01','2027-01-03']);
 assert.deepEqual(summarize(rows,new Date('2027-01-03T12:00:00')),{total:100,peak:20,activeDays:5,current:1,longest:4});
 assert.equal(summarize(rows,new Date('2027-01-04T12:00:00')).current,0);
});
test('聚合同日记录，空数据与闰月连续计算准确',()=>{
 assert.equal(summarize(days(['2028-02-28','2028-02-29','2028-03-01']),new Date('2028-03-01T12:00:00')).current,3);
 const rows=days(['2026-11-15','2026-11-15']);assert.equal(summarize(rows).peak,40);assert.equal(summarize(rows).activeDays,1);
 assert.deepEqual(summarize([]),{total:0,peak:0,activeDays:0,current:0,longest:0});
});
test('Token 达到 K/M/B/T 阈值才换算，省略小数末尾的零',()=>{
 const {compact}=require('../src/usage-summary');
 for(const [input,expected]of [[0,'0'],[999,'999'],[1000,'1K'],[1500,'1.5K'],[999999,'999.99K'],[1000000,'1M'],[46528123,'46.53M'],[999999999,'999.99M'],[1000000000,'1B'],[1500000000,'1.5B'],[1000000000000,'1T']])assert.equal(compact(input),expected);
});
