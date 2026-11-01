const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function setup(cloud='test'){
 const updates=[],module={exports:{}};
 const userService={updateUser:async(id,data)=>{updates.push({id,data});return {avatarUrl:data.avatarUrl};}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../controllers/userController.js'),'utf8'),{module,exports:module.exports,URL,require:name=>name==='../services/userService'?userService:name==='../services/uploadService'?{cloudinary:{config:()=>({cloud_name:cloud})}}:{}});
 return {updates,invoke:async body=>{let result;const res={status(status){this.code=status;return this;},json(body){result={status:this.code,body};}};await module.exports.updateMe({body,user:{id:'me'}},res);return result;}};
}
test('saves a confirmed image URL from the configured cloud for the current user',async()=>{const {invoke,updates}=setup();const url='https://res.cloudinary.com/test/image/upload/v123/photo.jpg';assert.equal((await invoke({avatarUrl:url})).status,200);assert.equal(updates[0].id,'me');assert.equal(updates[0].data.avatarUrl,url);});
for(const url of ['http://res.cloudinary.com/test/image/upload/photo.jpg','https://res.cloudinary.com/other/image/upload/photo.jpg','https://evil.example/test/image/upload/photo.jpg','https://res.cloudinary.com/test/raw/upload/file.pdf','https://res.cloudinary.com/test/image/upload/photo.jpg?query=1'])test('rejects avatar URL '+url,async()=>{const {invoke,updates}=setup();assert.equal((await invoke({avatarUrl:url})).status,400);assert.equal(updates.length,0);});
test('ordinary profile edits still work without avatarUrl',async()=>{const {invoke,updates}=setup();assert.equal((await invoke({firstName:'Mota'})).status,200);assert.equal(updates[0].data.firstName,'Mota');});
