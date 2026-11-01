const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function setup(options={}) {
 let ledger=[],balance=0,pending=true,amount=options.amount??5000;
 const user={_id:'invitee',referredBy:options.legacy?undefined:'owner',role:options.passenger?'client':'driver',isVerified:!options.unverified,kycLevel:options.incompleteKyc?'basic':'full',registrationPaid:!options.unpaid,registrationStatus:options.unapproved?'pending':'approved'};
 const owner={_id:'owner',role:options.passengerOwner?'client':'driver',referralCode:'MOTA-ABC'};
 const referral={_id:'referral',referrerId:'owner',referredUserId:'invitee',reward:amount};
 const query=value=>({session:async()=>value,then:(resolve,reject)=>Promise.resolve(value).then(resolve,reject)});
 let gate=Promise.resolve();
 const mongoose={startSession:async()=>({endSession:async()=>{},withTransaction:async callback=>{const before=gate;let release;gate=new Promise(r=>release=r);await before;const snapshot={balance,ledger:[...ledger],pending};try{await callback();}catch(e){balance=snapshot.balance;ledger=snapshot.ledger;pending=snapshot.pending;throw e;}finally{release();}}})};
 const User={findById:id=>query(id==='owner'?owner:user),findOne:async()=>options.badCode?null:owner};
 const Referral={findOne:filter=>query(filter.status && !pending?null:referral),updateMany:async()=>{pending=false;}};
 const Wallet={findOneAndUpdate:async(_,update)=>{balance+=update.$inc.balance;}};
 const Transaction={findOne:()=>query(ledger[0]||null),create:async rows=>{if(options.ledgerFailure)throw Error('ledger unavailable');ledger.push(...rows);}};
 const configService={getConfig:async()=>options.config??5000};
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../services/referralService.js'),'utf8'),{module,exports:module.exports,require:name=>({mongoose,'../models/User':User,'../models/Referral':Referral,'../models/Wallet':Wallet,'../models/Transaction':Transaction,'./configService':configService})[name],process:{env:{FINANCIAL_WRITES_ENABLED:options.disabled?'false':'true'}},console:{error(){}}});
 return {service:module.exports,state:()=>({balance,ledger,pending})};
}
test('normalizes codes and resolves the configured reward',async()=>{const {service}=setup({config:6200});assert.equal(service.normalizeCode(' mota-abc '),'MOTA-ABC');assert.equal((await service.resolveReferral('mota-abc','driver')).reward,6200);});
test('invalid code is rejected before account registration',async()=>{await assert.rejects(setup({badCode:true}).service.resolveReferral('unknown','driver'),e=>e.status===400);});
test('empty optional code has no referral',async()=>assert.equal(await setup().service.resolveReferral(' ','driver'),null));
test('passenger invitations have no cash reward',async()=>assert.equal((await setup().service.resolveReferral('code','client')).reward,0));
test('passenger referrers have no cash reward',async()=>assert.equal((await setup({passengerOwner:true}).service.resolveReferral('code','driver')).reward,0));
test('credits and records the stored reward once across repeated approval',async()=>{const {service,state}=setup();await service.settleReferral('invitee');await service.settleReferral('invitee');assert.equal(state().balance,5000);assert.equal(state().ledger.length,1);assert.equal(state().ledger[0].idempotencyKey,'referral:invitee');assert.equal(state().pending,false);});
test('concurrent checks credit once',async()=>{const {service,state}=setup();await Promise.all([service.settleReferral('invitee'),service.settleReferral('invitee')]);assert.equal(state().balance,5000);assert.equal(state().ledger.length,1);});
test('ledger failure rolls back the wallet and leaves reward pending',async()=>{const {service,state}=setup({ledgerFailure:true});await assert.rejects(service.settleReferral('invitee'));assert.equal(state().balance,0);assert.equal(state().ledger.length,0);assert.equal(state().pending,true);});
for(const option of ['unverified','unpaid','disabled','incompleteKyc','unapproved'])test(option+' leaves cash reward pending without credit',async()=>{const {service,state}=setup({[option]:true});await service.settleReferral('invitee');assert.equal(state().balance,0);assert.equal(state().pending,true);});
test('verified passenger invitation completes without cash or registration fee',async()=>{const {service,state}=setup({passenger:true,unpaid:true});await service.settleReferral('invitee');assert.equal(state().balance,0);assert.equal(state().pending,false);});
test('invalid reward configuration is rejected',async()=>await assert.rejects(setup({config:-1}).service.resolveReferral('code','driver'),/configuration/));

test('historical pending referral requires audit before automated credit',async()=>{const {service,state}=setup({legacy:true});await service.settleReferral('invitee');assert.equal(state().balance,0);assert.equal(state().pending,true);});
