const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function setup(options={}){
 const calls=[],records=new Map();
 const Ride={collection:{name:'rides'},findOne:filter=>{calls.push(filter);return {select:async()=>options.unassigned?null:{_id:'ride'}};}};
 const Receipt={init:async()=>{},updateOne:async(filter,update)=>{if(options.failure)throw options.failure;const key=filter.driverId+filter.rideId;if(!records.has(key))records.set(key,update.$setOnInsert.receivedAt);},aggregate:async pipeline=>{calls.push(pipeline);return options.aggregate||[];}};
 const mongoose={isValidObjectId:value=>/^[a-f0-9]{24}$/i.test(value),Types:{ObjectId:class{constructor(id){this.id=id;}}}};
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../services/driverPerformanceService.js'),'utf8'),{module,exports:module.exports,Date,require:name=>({mongoose,'../models/Ride':Ride,'../models/DriverOfferReceipt':Receipt})[name]});
 return {service:module.exports,calls,records};
}
const rideId='0123456789abcdef01234567';
test('validates allowed reporting windows',()=>{const {service}=setup();for(const days of [7,30,90])assert.equal(service.parseWindow(String(days)),days);for(const value of [0,1,365,'bad'])assert.throws(()=>service.parseWindow(value),e=>e.status===400);});
test('one offer counts once and retains first receipt time',async()=>{const {service,records}=setup();await service.acknowledgeOffer('driver',rideId);const first=records.values().next().value;await service.acknowledgeOffer('driver',rideId);assert.equal(records.size,1);assert.equal(records.values().next().value,first);});
test('acknowledgment requires assignment and an active offer',async()=>{const {service,calls}=setup({unassigned:true});await assert.rejects(service.acknowledgeOffer('driver',rideId),e=>e.status===404);assert.deepEqual(JSON.parse(JSON.stringify(calls[0].$or)),[{notifiedDrivers:'driver'},{driverId:'driver'}]);assert.equal(calls[0].rideStatus.$in.includes('completed'),false);});
test('invalid IDs fail before database query',async()=>{const {service,calls}=setup();await assert.rejects(service.acknowledgeOffer('driver','invalid'),e=>e.status===400);assert.equal(calls.length,0);});
test('concurrent duplicate-key acknowledgment is successful',async()=>{await setup({failure:{code:11000}}).service.acknowledgeOffer('driver',rideId);});
test('database failures are not reported as successful receipts',async()=>{await assert.rejects(setup({failure:Error('offline')}).service.acknowledgeOffer('driver',rideId),/offline/);});
test('zero denominators produce null rates, not misleading zero percentages',()=>{const result=setup().service.summarize();assert.equal(result.acceptanceRate,null);assert.equal(result.cancellationRate,null);});
test('rates use separate denominators and exclude passenger cancellations',()=>{const result=setup().service.summarize({offers:12,accepted:8,driverCancelled:1,passengerCancelled:3,completed:4});assert.equal(result.acceptanceRate,66.7);assert.equal(result.cancellationRate,12.5);assert.equal(result.passengerCancelled,3);});
function evaluate(expression,row){
 if(typeof expression==='string'&&expression.startsWith('$'))return expression.slice(1).split('.').reduce((v,key)=>v?.[key],row);
 if(expression===null||typeof expression!=='object')return expression;
 if(Array.isArray(expression))return expression.map(x=>evaluate(x,row));
 const [op,value]=Object.entries(expression)[0],args=evaluate(value,row);
 if(op==='$eq')return args[0]===args[1];if(op==='$ne')return args[0]!==args[1];if(op==='$ifNull')return args[0]??args[1];if(op==='$and')return args.every(Boolean);if(op==='$cond')return args[0]?args[1]:args[2];throw Error(op);
}
test('offer cohort aggregation distinguishes driver, passenger and other-driver outcomes',()=>{
 const pipeline=setup().service.buildPipeline('driver','start','end');
 assert.equal(pipeline[0].$match.driverId,'driver');assert.equal(pipeline[0].$match.receivedAt.$gte,'start');assert.equal(pipeline[0].$match.receivedAt.$lte,'end');
 const rides=[{driverId:'driver',acceptedAt:1,rideStatus:'completed'},{driverId:'driver',acceptedAt:1,rideStatus:'cancelled',cancelledBy:'driver',passengerId:'passenger'},{driverId:'driver',acceptedAt:1,rideStatus:'cancelled',cancelledBy:'passenger',passengerId:'passenger'},{driverId:'other',acceptedAt:1,rideStatus:'completed'},{driverId:'driver',rideStatus:'searching'}];
 const totals={};for(const ride of rides){const row={ride};row.accepted=evaluate(pipeline[3].$set.accepted,row);for(const [key,expression] of Object.entries(pipeline[4].$group)){if(key==='_id')continue;totals[key]=(totals[key]||0)+evaluate(expression.$sum,row);}}
 assert.deepEqual(totals,{offers:5,accepted:3,driverCancelled:1,passengerCancelled:1,completed:1});
});
test('empty dataset returns a complete dated response for requested period',async()=>{const result=await setup().service.getPerformance(rideId,7);assert.equal(result.offers,0);assert.equal(result.days,7);assert.equal(result.asOf-result.from,7*24*60*60*1000);assert.equal(result.basis,'app_acknowledged_offer_cohort');});
