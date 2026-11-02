import assert from 'node:assert/strict';
const { avatarControlAllowed, withoutAvatarTools } = await import('../src/services/avatar-policy.js');
assert.equal(avatarControlAllowed({},null),true);
assert.equal(avatarControlAllowed(undefined,null),true);
assert.equal(avatarControlAllowed({hide_pixel_avatar:true},null),false);
assert.equal(avatarControlAllowed({disable_avatar_control:true},null),false);
assert.equal(avatarControlAllowed({},'/images/bot.png'),false);
assert.equal(avatarControlAllowed({hide_pixel_avatar:false,disable_avatar_control:false},'/images/bot.png'),false);
const tools = [
 {function:{name:'get_avatar_state'}}, {function:{name:'set_display_state'}},
 {function:{name:'create_pixel_image',parameters:{properties:{prompt:{type:'string'},set_as_avatar:{type:'boolean'}},required:['prompt','set_as_avatar']}}},
 {function:{name:'get_user_time'}},
];
const original=JSON.stringify(tools);
const filtered=withoutAvatarTools(tools);
assert.deepEqual(filtered.map(tool=>tool.function.name),['create_pixel_image','get_user_time']);
assert.equal('set_as_avatar' in filtered[0].function.parameters.properties,false);
assert.deepEqual(filtered[0].function.parameters.required,['prompt']);
assert.equal(JSON.stringify(tools),original,'shared tool definitions must not mutate across requests');
console.log('Avatar policy: hidden, disabled, custom image, tool removal and immutable schemas passed.');
