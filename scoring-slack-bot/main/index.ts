import Spreadsheet = GoogleAppsScript.Spreadsheet.Spreadsheet;
import Sheet = GoogleAppsScript.Spreadsheet.Sheet;

/**
 BUGS:
 - When command is asked into a thread, it would be better to answer directly into into the thread instead of into the channel
 */

const PROPS = {
  SLACK_ACCESS_TOKEN: PropertiesService.getScriptProperties().getProperty('SLACK_ACCESS_TOKEN'),
  LOG_ENABLED: PropertiesService.getScriptProperties().getProperty('LOG_ENABLED'),
  SPREADSHEET_ID: PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'),
  SLACK_CHALLENGE_ACTIVATED: PropertiesService.getScriptProperties().getProperty('SLACK_CHALLENGE_ACTIVATED')
};

var EMOJIS_PER_RANKS = {
  1: ":first_place_medal:",
  2: ":second_place_medal:",
  3: ":third_place_medal:"
};

interface SlackEvent {
  text: string;
  type: string;
}

interface BotResettedEvent extends SlackEvent {
  bot_id: string;
}
interface ReactionEvent extends SlackEvent {
  user: string;
  item_user: string;
  item: {
    channel: string;
    ts: string;
  }
  reaction: string;
}
interface ChannelMessageEvent extends SlackEvent {
  channel: string;
  user: string;
  thread_ts?: string;
}

interface ChannelConfig {
  adminUser?: string;
  restrictReactionsToThreadAuthors: boolean;
  reactionsConfigs: {
    [reaction in string]: {scoreIncrement: number};
  };
}

interface ChannelDescriptor {
  channelId: string;
  config: ChannelConfig;
  sheetName: string;
  reactionSheetName: string;
  leaderboardLink: string;
}

interface MessageInfos {
  threadId: string;
  threadAuthorId: string;
  text: string;
}

interface User {
  id: string;
  name: string;
}
type UsersById = { [key in string]: User };

function doPost(e){
  var payload = JSON.parse(e.postData.contents);
  if(PROPS.SLACK_CHALLENGE_ACTIVATED === "true") {
    // ScoringBot.INSTANCE.log("Challenge activated and returned !");
    return ContentService.createTextOutput(payload.challenge);
  } else {
    ScoringBot.INSTANCE.log('POST event: ' + JSON.stringify(payload));
  }

  var event: SlackEvent = payload.event;
  return ScoringBot.INSTANCE.handle(event);
}

class ScoringBot {
  static readonly INSTANCE = new ScoringBot();

  private spreadsheetApp: Spreadsheet;

  private constructor() {
    this.spreadsheetApp = null;
  }

  handle(event: SlackEvent): void {
    try {
      if(ScoringBot.isBotResettedEvent(event)) {
        this.handleBotResetted(event);
      } else if(ScoringBot.isReactionAdded(event) || ScoringBot.isReactionRemoved(event)) {
        this.logReaction(event);
      } else if(ScoringBot.isSetupChannelCommand(event)) {
        this.setupChannel(event);
        this.updateUsers();
      } else if(ScoringBot.isUpdateUsersCommand(event)) {
        this.updateUsers();
        this.botShouldSay(event.channel, "Users have been updated", event.thread_ts);
      } else if(ScoringBot.isScoresCommand(event)) {
        this.showScores(event);
      } else if(ScoringBot.isHelpCommand(event)) {
        this.showHelp(event);
      } else {
        this.log("No callback matched event !");
      }
    }catch(e){
      this.log(`Error during following payload : ${JSON.stringify(event)}: ${e.toString()}`);
    }
  }

  handleBotResetted(event: BotResettedEvent) {
    this.log("Bot reloaded: "+event.bot_id);
    return;
  }

  logReaction(event: ReactionEvent) {
    const channelConfig = this.getConfigForChannel(event.item.channel);
    const sheet = this.getSheetByName(channelConfig.reactionSheetName);

    const messageInfos = this.retrieveMessageInfosFor(event.item.channel, event.item.ts);
    sheet.appendRow([
      new Date(), event.user, event.item_user, event.item.channel, event.reaction, event.type,
      messageInfos?messageInfos.threadId:"", messageInfos?messageInfos.threadAuthorId:"", messageInfos?messageInfos.text:""
    ]);
  }

  setupChannel(event: ChannelMessageEvent) {
    const spreadsheet = this.getSpreadsheetApp();

    // If config/userlist/logs tab don't exist yet, it means that spreadsheet has not been initialized yet and we need to create it on the fly
    this.ensureSheetCreated("UserList", ["id", "name"], "values");
    const configSheet = this.ensureSheetCreated("Config", ["Channel", "Sheet basename", "ChannelConfig", "Leaderboard link"], "values");

    let channelConfig = this.getConfigForChannel(event.channel);
    if(channelConfig){
      this.botShouldSay(event.channel, "Current channel seems to already have been setup", event.thread_ts);
      return;
    }

    let args = event.text.split(" ");
    args.shift();
    if(args.length != 1) {
      this.botShouldSay(event.channel, "Usage: !setup <config name>", event.thread_ts);
      return;
    }
    const configName = args[0];

    configSheet.appendRow([ event.channel, configName, JSON.stringify({
      adminUser: event.user,
      restrictReactionsToThreadAuthors:true,
      reactionsConfigs: { "white_check_mark": {"scoreIncrement":2}, "lock":{"scoreIncrement":1} }
    }), "" ]);

    channelConfig = this.getConfigForChannel(event.channel);

    const newRowIndex = configSheet.getDataRange().getNumRows();

    const scoreSheet = spreadsheet.insertSheet(channelConfig.sheetName, spreadsheet.getSheets().length);
    const reactionsSheet = spreadsheet.insertSheet(channelConfig.reactionSheetName, spreadsheet.getSheets().length);

    this.setSheetHeaderRows(scoreSheet, ["=SCORES_FOR_CHANNEL(Config!$A$"+newRowIndex+";Config!$C$"+newRowIndex+";UserList!A:B;'"+channelConfig.reactionSheetName+"'!A:I)"], "formulas");

    reactionsSheet.deleteRows(2, reactionsSheet.getMaxRows() - 2);
    reactionsSheet.getRange(1, 10, 1, 1).setFormulas([
      ["=EXTRACT_SCORES_FROM_REACTIONS(Config!$A$"+newRowIndex+";Config!$C$"+newRowIndex+";UserList!A:B;A:I)"]
    ]);
    this.setSheetHeaderRows(reactionsSheet, ["date", "issuer user id", "target user id", "channel reaction", "type", "thread id", "thread author id", "target message"], "values");

    this.botShouldSay(event.channel, "Your config ["+configName+"] has been successfully initialized !\n⚠️Don't forget to publish the score sheet and put the link in the leaderboard channel configuration.", event.thread_ts);
  }

  ensureSheetCreated(sheetName: string, headerCells: string[]|null, headerCellsType: "formulas"|"values"|null) {
    let sheet = this.getSheetByName(sheetName);
    if(!sheet) {
      sheet = this.getSpreadsheetApp().insertSheet(sheetName, 0);
      if(headerCells && headerCellsType) {
        this.setSheetHeaderRows(sheet, headerCells, headerCellsType);
      }
    }
    return sheet;
  }

  setSheetHeaderRows(sheet: Sheet, headerCells: string[], type: "formulas"|"values") {
    if(type === 'formulas') {
      sheet.getRange(1, 1, 1, headerCells.length).setFormulas([ headerCells ]);
    } else {
      sheet.getRange(1, 1, 1, headerCells.length).setValues([ headerCells ]);
    }
    sheet.getRange(1, 1, 1, sheet.getMaxColumns()).setFontWeight("bold");
  }

  updateUsers() {
    const payload = JSON.parse(UrlFetchApp.fetch('https://slack.com/api/users.list', {method: 'get', payload: { token: PROPS.SLACK_ACCESS_TOKEN }}).getContentText());
    const sheet = this.getSheetByName("UserList");
    const rows = [ [ "id", "name" ] ];
    for(let i=0; i<payload.members.length; i++){
      let member = payload.members[i];
      rows.push([ member.id, member.name ]);
    }
    sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  }

  showScores(event: ChannelMessageEvent) {
    const channel = event.channel;
    const channelConfig = this.getConfigForChannel(channel);

    if(!channelConfig) {
      this.botShouldSay(channel, "I was unable to locate channel config for ["+channel+"] in the spreadsheet !", event.thread_ts);
      return;
    }

    const scoresSheet = this.getSheetByName(channelConfig.sheetName);
    if(!scoresSheet) {
      this.botShouldSay(channel, "I was unable to locate spreadsheet's sheet named ["+channelConfig.sheetName+"] corresponding to channel ["+channel+"] !", event.thread_ts);
      return;
    }

    const scoresData = scoresSheet.getDataRange().getValues();
    const scoresMessage = this.createScoreMessagesFrom(scoresData);
    if(!scoresMessage) {
      this.botShouldSay(channel, "No score available yet in spreadsheet's sheet named ["+channelConfig.sheetName+"] corresponding to channel ["+channel+"] !", event.thread_ts);
      return;
    }

    this.botShouldSay(channel, scoresMessage+(channelConfig.leaderboardLink?"\n_Complete leaderboard is available here : "+channelConfig.leaderboardLink+" _":""), event.thread_ts);
  }

  showHelp(event: ChannelMessageEvent) {
    const channel = event.channel;
    const channelConfig = this.getConfigForChannel(channel);
    if(!channelConfig) {
      this.botShouldSay(channel, `
It appears this channel has not be configured yet.
To initialize it, you can type \`!setup <configuration name>\`, it will initialize channel configuration into the spreadsheet. \`<configuration name>\` is a name that will be used for spreadsheet tabs.
      `, event.thread_ts);
      return;
    }

    const usersById = this.getUsersById();

    let message = `Hello ! I am a bot having the goal to take note of scores when questions are asked on this channel.
My work aims at looking at some interactions and react depending on these.
*Note*: _I look for interactions only once I am invited on the channel._

Following observed interactions are configured on this channel :
`
    let allowedUserMessage;
    if(channelConfig.config.adminUser && channelConfig.config.restrictReactionsToThreadAuthors) {
      allowedUserMessage = "by this channel admin ("+usersById[channelConfig.config.adminUser].name+") or question thread author";
    } else if(channelConfig.config.adminUser) {
      allowedUserMessage = "by this channel admin ("+usersById[channelConfig.config.adminUser].name+")";
    } else if(channelConfig.config.restrictReactionsToThreadAuthors) {
      allowedUserMessage = "by question thread author";
    } else {
      allowedUserMessage = "by anyone on this channel";
    }

    const configuredReactions = Object.keys(channelConfig.config.reactionsConfigs);
    for(let i=0; i<configuredReactions.length; i++){
      const reaction = configuredReactions[i];
      const scoreIncrement = channelConfig.config.reactionsConfigs[reaction].scoreIncrement;
      message += `- When reaction :${reaction}: is set ${allowedUserMessage} : adding ${scoreIncrement} point${(scoreIncrement>1?"s":"")} for target message's author receving the reaction\n`;
    }

    message += `
Following commands are available :
- \`!help\` : Shows help
- \`!scores\` : Show podium (scores total) for this channel. ${channelConfig.leaderboardLink?"Complete leaderboard is available here "+channelConfig.leaderboardLink+".":""}
- \`!update-users\` : Refreshes this slack server's users list (when a username changes, or new users are added on Slack)
- \`!setup <configuration name>\` : Initializes channel configuration into the spreadsheet. \`<configuration name>\` is a name that will be used for spreadsheet tabs.
`;

    this.botShouldSay(channel, message, event.thread_ts);
  }

  createScoreMessagesFrom(scoresData: string[][]): string|null {
    const bestUsers: {score: number, userNames: string[]}[] = [];
    for(let i=1; i<scoresData.length; i++) {
      const rank = Number(scoresData[i][2]);
      if(rank <= 3) {
        bestUsers[rank] = bestUsers[rank] || { score: Number(scoresData[i][1]), userNames: [] };
        bestUsers[rank].userNames.push(scoresData[i][0]);
      }
    }

    if(bestUsers.length) {
      return "*Leaderboard*: "+bestUsers.map((bestUser, idx) =>
        `${EMOJIS_PER_RANKS[idx]} ${bestUser.userNames.join(", ")} (${bestUser.score} pts)`
      ).join(" ");
    } else {
      return null;
    }
  }

  getConfigForChannel(channel: string): ChannelDescriptor|null {
    const configSheet = this.getSheetByName("Config");
    const configData = configSheet.getDataRange().getValues();
    let channelConfig = null, sheetName = null;
    for(let i=1; i<configData.length; i++){
      if(configData[i][0] === channel) {
        return {
          channelId: channel,
          config: JSON.parse(configData[i][2]),
          sheetName: configData[i][1],
          reactionSheetName: configData[i][1]+"-ReactionsLog",
          leaderboardLink: configData[i][3]
        };
      }
    }
    return null;
  }

  retrieveMessageInfosFor(channel: string, messageId: string): MessageInfos|null {
    var payloadText = UrlFetchApp.fetch('https://slack.com/api/conversations.replies', {method: 'get', payload: { token: PROPS.SLACK_ACCESS_TOKEN, channel: channel, ts: messageId }}).getContentText();
    this.log("resulting conversations replies payload : "+payloadText);
    const payload = JSON.parse(payloadText);
    
    if(payload && payload.messages && payload.messages[0]) {
      return {
        threadId: payload.messages[0].thread_ts,
        threadAuthorId: payload.messages[0].parent_user_id || payload.messages[0].user,
        text: payload.messages[0].text
      };
    } else {
      return null;
    }
  }

  getSheetByName(name: string): Sheet {
    return this.getSpreadsheetApp().getSheetByName(name);
  }
  
  getSpreadsheetApp(): Spreadsheet {
    if(!this.spreadsheetApp) {
      this.spreadsheetApp = SpreadsheetApp.openById(PROPS.SPREADSHEET_ID);
    }
    return this.spreadsheetApp;
  }

  getUsersById(): UsersById {
    const usersSheet = this.getSheetByName("UserList");
    const userData = usersSheet.getDataRange().getValues();
    const usersById: UsersById = {};
    for(let i=1; i<userData.length; i++){
      const uid = userData[i][0];
      usersById[uid] = { id: uid, name: userData[i][1] };
    }
    return usersById;
  }

  botShouldSay(channel: string, text: string, threadId?: string): void {
    var payload = {token: PROPS.SLACK_ACCESS_TOKEN, channel:channel, text:text, thread_ts: threadId };
    UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {method: 'post', payload: payload});
  }

  log(text){
    if(PROPS.LOG_ENABLED === "true" && PROPS.SPREADSHEET_ID) {
      console.log(text);
      const logsSheet = this.ensureSheetCreated("Logs", null, null);
      logsSheet.appendRow([new Date(), text]);
    }
  }

  static isBotResettedEvent(event: SlackEvent): event is BotResettedEvent { return event.hasOwnProperty('bot_id'); }
  static isReactionAdded(event: SlackEvent): event is ReactionEvent { return event.type === 'reaction_added'; }
  static isReactionRemoved(event: SlackEvent): event is ReactionEvent { return event.type === 'reaction_removed'; }
  static isUpdateUsersCommand(event: SlackEvent): event is ChannelMessageEvent { return !!event.text.match(/!update-users/); }
  static isSetupChannelCommand(event: SlackEvent): event is ChannelMessageEvent { return !!event.text.match(/!setup/); }
  static isScoresCommand(event: SlackEvent): event is ChannelMessageEvent { return !!event.text.match(/!scores/); }
  static isHelpCommand(event: SlackEvent): event is ChannelMessageEvent { return !!event.text.match(/!help/); }
}

