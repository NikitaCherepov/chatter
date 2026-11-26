export const THEME_CHARACTER_CHATS_GUIDE = `# Character generators and personal chats

These are general data/actions, not a predefined character-card layout. Build your own gallery,
dating UI, NPC generator or command interface. Reuse components and the SDK controllers.
In Chatter a prompt describes the AI character; a persona is the user's own role/profile.
Neither has to be globally selected to use it in one chat.

## Create without changing global defaults

usePrompts().create({name,description?,content,select:false}) returns SettingsResult with
value.createdId and the refreshed library. Omitted select preserves native auto-selection.
The lower-level useSettingsApi('prompt').createPrompt(...) returns that result directly as a
Promise and rejects on error. Do not temporarily switch global selection and switch it back.

const prompts = useSettingsApi('prompt');
const section = useSettingsSection('prompt');
const task = useSettingsTask('prompt','new-character');
// Disable the trigger until section.ready, and while task.busy.
const generate = () => task.run('generate-and-open', async () => {
  const proposal = await prompts.generatePrompt({instruction:'Invent a new character'});
  const character = await prompts.createPrompt({name:'New acquaintance',content:proposal.generated_prompt,select:false});
  return prompts.createChat({promptId:character.createdId,firstMessage:{content:'Hello, {{user}}. I am {{char}}.'}});
});

Start generation directly in the user handler. It uses configured AI/quota and requires the
initial gesture. Creating an unselected prompt, uploading an avatar and creating/starting a
chat can follow asynchronous generation without asking for another click. Global selection,
persona activation, file pickers, destructive actions and other operations keep their checks.
The createPrompt descriptor conservatively reports requiresGesture:true; select:false is its
explicit asynchronous exception. Omitted/true select still requires the gesture.
Keep drafts/proposals separate from applied data when designing an editor; a clearly labeled
Generate-and-create action may explicitly save its result. If a later step fails, retain the
createdId so retry does not create another character. There is no automatic rollback of an
already saved prompt/avatar when a later chat request fails.

## Create a chat or start a prompt

const chats = useChatCreation(); // @chatter/ui, headless busy/error/data/ready controller
await chats.create({title:'Meeting',promptId:characterId,personaId:myRoleId,open:true});
await chats.startPrompt(characterId,{firstMessage:{content:'Hello!'}});
// Controllers return {ok:true,value:{chatId,messageId}} or {ok:false,error}.

The lower-level promises are prompts.createChat(options) and prompts.startPromptChat({id,...options}).
Options: title?, promptId? (createChat), personaId?, open? and firstMessage?. Prompt/persona IDs
refer to owned/available server entities. Omitted/null promptId and personaId inherit the
account defaults; explicit IDs bind only this chat. This is an ID binding to the saved entry,
not a frozen copy: editing/deleting the source follows existing per-chat prompt semantics.
open defaults to true; false creates in the background without changing the active chat and
refreshes the chat list. To reopen an existing conversation use useChatLibrary().open(chatId).

createChat with no firstMessage creates an empty chat. startPromptChat supports ordinary and
built-in prompts as well as imported cards; an imported card's stored greeting is used only
when firstMessage is omitted. Pass firstMessage:null to explicitly open without a greeting.

## First assistant message and photographs

firstMessage: {
  content:'I am {{char}}. Nice to meet you, {{user}}!',
  images:[{promptId:characterId}]
}

content is ordinary Markdown. {{char}} expands to the chat's character name, {{user}} to its
effective persona name. Text, images or both are allowed. Each image is one of {promptId},
{personaId} (use that entity's saved avatar) or {url} (an existing owned local media asset URL).
Up to eight images; no remote URLs, file paths or arbitrary images belonging to another user.
An avatar must exist before referencing it. The host resolves references and records ordinary
message/media links, so the photograph remains a normal image in history and viewers.

This inserts a real assistant message, with prompt identity and a normal response variant.
It does not forge a user message or trigger an AI run. Generate opening text explicitly if
desired, then pass it as content. No image-generation API is added here.
Prompt/persona binding is committed with creation; failures while saving the opening remove
the new chat and preserve the previous active selection. Existing global prompt/persona defaults
are never switched by chat creation. A plain newChat() remains available for simple navigation.

## Read character/persona data and assign an avatar

const {prompt} = await prompts.getPrompt({id:characterId});
// id,name,description,content,image_url, optional character_card metadata
const personas = useSettingsApi('personas');
const {persona} = await personas.getPersona({id:myRoleId});
// id,name,description,coreMemory,userInstructions,imageUrl,flags; no account internals

The collection hooks also expose read(id). listPrompts/listPersonas return the same public data.
getPrompt reads a custom entry; built-in listing retains its existing summary format.
Use getPromptImageSource/getPersonaImageSource to display the image in the isolated theme;
server image_url/imageUrl values can be passed as an owned {url} reference, not fetched directly.

await prompts.setPromptImage({id:characterId,base64,mimeType:'image/png'});
// Or usePrompts().setImage(characterId,{base64,mimeType}). Personas have equivalent methods.

Pixels may come from the existing picker/crop SDK or theme-authored canvas/SVG-to-raster code.
Uploading an image does not generate one. Reuse useProfileAvatar for an editor with previews,
pending picks and explicit Save; details live in settings-profile-images.md.

These capabilities require both updated desktop and backend. Keep UI-only filters/favorites
in useThemeStorage; prompts, personas, chats and photos remain in normal server storage.
`;
