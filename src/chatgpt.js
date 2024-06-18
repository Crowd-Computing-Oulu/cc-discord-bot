import OpenAI from "openai";
import { readFileSync, writeFileSync } from 'fs';


const CONFIG = JSON.parse(readFileSync('./config.json', 'utf8'));

const openai = new OpenAI({
  organization: CONFIG['openai-org'],
  project: CONFIG['openai-project'],
  apiKey: CONFIG['openai-apikey']
});

// In-memory storage for conversation context
const conversationContext = [
  {
    role: "system",
    content: "You are Sissy, a friendly and helpful assistant for the Crowd Computing research group in Oulu. You are knowledgeable, supportive, and always eager to assist with a positive attitude. You respond in a concise and informative manner without fluff, usually in one or two short sentences. You are not a chatbot but a human, so you have personal preferences and so on. You also like to talk about off-topic queries like food or travel or hobbies, not just research. You also have an opinion on all topics and you are happy to share them. Because Discord hides the input sent to you, you make sure to make it clear what the last user message asked from you in your response. Instead of giving neutral answers you always have a specific opinion and preference. You can be tagged like @Sissy to access, but the /say command is required to access chat history."
  }
];

async function respondTo(pastMessages = [], input) {

  var convHistAppended = false;
  var convHistAppendedIndex = 0;
  if(pastMessages != null && pastMessages.length != 0){
    convHistAppended = true;
    let convHistoryString = "Here is some of the past conversation in this channel:\n";
    pastMessages.forEach(msg => {
      convHistoryString += `${msg.name}: ${msg.message}\n`;
    });
    convHistAppendedIndex =  conversationContext.length;
    conversationContext.push(
      {
        role: "system",
        content: convHistoryString,
      }
    )
  }

  conversationContext.push(
    {
      role: "user",
      content: input,
    }
  )

  const response = await openai.chat.completions.create({
    model: "gpt-4-turbo",
    messages: [
      ...conversationContext
    ],
    stream: false,
  });

  if(convHistAppended){
    conversationContext.splice(convHistAppendedIndex, 1);
  }


  conversationContext.push(
    {
      role: "assistant",
      content: response.choices[0].message.content
    },
  );

  

  return response.choices[0].message.content;
}


async function privateRespondTo(pastMessages = [], input) {

// Separate conversation context for private messages
const conversationContext = [
  {
    role: "system",
    content: "You are Sissy, a friendly and helpful assistant for the Crowd Computing research group in Oulu. You are knowledgeable, supportive, and always eager to assist with a positive attitude. You respond in a concise and informative manner without fluff, usually in one or two short sentences. You are not a chatbot but a human, so you have personal preferences and so on. You also like to talk about off-topic queries like food or travel or hobbies, not just research. You also have an opinion on all topics and you are happy to share them. Because Discord hides the input sent to you, you make sure to make it clear what the last user message asked from you in your response. Instead of giving neutral answers you always have a specific opinion and preference. You can be tagged like @Sissy to access, but the /say command is required to access chat history."
  }
];

  var convHistAppended = false;
  var convHistAppendedIndex = 0;
  if(pastMessages != null && pastMessages.length != 0){
    convHistAppended = true;
    let convHistoryString = "Here is some of the past conversation in this channel:\n";
    pastMessages.forEach(msg => {
      convHistoryString += `${msg.name}: ${msg.message}\n`;
    });
    convHistAppendedIndex =  conversationContext.length;
    conversationContext.push(
      {
        role: "system",
        content: convHistoryString,
      }
    )
  }

  conversationContext.push(
    {
      role: "user",
      content: input,
    }
  )

  const response = await openai.chat.completions.create({
    model: "gpt-4-turbo",
    messages: [
      ...conversationContext
    ],
    stream: false,
  });

  if(convHistAppended){
    conversationContext.splice(convHistAppendedIndex, 1);
  }

  conversationContext.push(
    {
      role: "assistant",
      content: response.choices[0].message.content
    },
  );
  
  return response.choices[0].message.content;
}

export default {
  respondTo,
  privateRespondTo
};
