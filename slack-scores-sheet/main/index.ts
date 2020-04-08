/// <reference path="luxon.d.ts" />

/*
channelConfig should look like this :
{
  "adminUser": "U5PQJFM9C", // facultative, allow to "trust" every reactions from this user
  "restrictReactionsToThreadAuthors": true,
  "reactionsConfigs": {
    "100": { "scoreIncrement": 1 },
    "heavy_check_mark": { "scoreIncrement": 1 },
    "white_check_mark": { "scoreIncrement": 1 },
    "trophy": { "scoreIncrement": 10 }
  }
}*/

interface User {
  id: string;
  name: string;
}
type UsersById = { [key in string]: User };

interface ReactionLog {
  date: Date;
  issuerUserId: string;
  targetUserId: string;
  channel: string;
  reaction: string;
  type: "reaction_removed"|"reaction_added";
  threadId: string;
  threadAuthorUserId: string;
}

interface ChannelConfig {
  adminUser?: string;
  restrictReactionsToThreadAuthors: boolean;
  reactionsConfigs: {
    [reaction in string]: {scoreIncrement: number};
  };
}

interface ScoreLog {
  issuerUserId: string;
  issuerName: string;
  targetUserId: string;
  targetName: string;
  reaction: string;
  scoreChange: number|null;
}

interface UserScore {
  id: string;
  name: string;
  score: number;
  scoresByReactions: {
    [reaction: string]: number
  }
}
type ScoreByUserId = {[userId: string]: UserScore};

function EXTRACT_SCORES_FROM_REACTIONS(channelName: string, textualChannelConfig: string, usersData: string[][], reactionLogsData: string[][]) {
  const usersById = getUsersFrom(usersData);
  const reactionLogs = getReactionLogsFrom(reactionLogsData);

  const scoreLogs = generateScoreLogsFor(channelName, JSON.parse(textualChannelConfig), usersById, reactionLogs);
  const scoresRows = [[ "issuer name", "target name", "score change" ]]
    .concat(scoreLogs.map(scoreLog => [ scoreLog.issuerName, scoreLog.targetName, scoreLog.scoreChange as any ]))

  return scoresRows;
}

function SCORES_FOR_CHANNEL(channelName: string, textualChannelConfig: string, usersData: string[][], reactionLogsData: string[][]) {
  const usersById = getUsersFrom(usersData);
  const reactionLogs = getReactionLogsFrom(reactionLogsData);
  const totalScores = generateTotalScoresFor(channelName, JSON.parse(textualChannelConfig), usersById, reactionLogs);
  return totalScores;
}


function generateScoreLogsFor(channelName: string, channelConfig: ChannelConfig, usersById: UsersById, reactionLogs: ReactionLog[]): ScoreLog[] {
  return reactionLogs.map(rl => ({
    issuerUserId: rl.issuerUserId,
    issuerName: usersById[rl.issuerUserId].name,
    targetUserId: rl.targetUserId,
    targetName: usersById[rl.targetUserId].name,
    reaction: rl.reaction,
    scoreChange: scoreChangeFor(rl, channelName, channelConfig)
  }));
}

function scoreChangeFor(reactionLog: ReactionLog, inChannel: string, channelConfig: ChannelConfig): number|null {
  let scoreChange: number|null = null;
  if(inChannel === reactionLog.channel
      && !!channelConfig.reactionsConfigs[reactionLog.reaction]
      && ((channelConfig.adminUser && channelConfig.adminUser === reactionLog.issuerUserId)
          || !channelConfig.restrictReactionsToThreadAuthors
          || reactionLog.threadAuthorUserId == reactionLog.issuerUserId)
  ) {
    scoreChange = channelConfig.reactionsConfigs[reactionLog.reaction].scoreIncrement * (reactionLog.type === 'reaction_removed'?-1:1);
  }
  return scoreChange;
}

function generateTotalScoresFor(channelName: string, channelConfig: ChannelConfig, usersById: UsersById, reactionLogs: ReactionLog[]) {
  const scoreLogs = generateScoreLogsFor(channelName, channelConfig, usersById, reactionLogs);
  const scoreByUserId: ScoreByUserId = {};
  for(let i=0; i<scoreLogs.length; i++) {
    if(scoreLogs[i].scoreChange) {
      scoreByUserId[scoreLogs[i].targetUserId] = scoreByUserId[scoreLogs[i].targetUserId] || { id: scoreLogs[i].targetUserId, name: usersById[scoreLogs[i].targetUserId].name, score: 0, scoresByReactions: {} };
      scoreByUserId[scoreLogs[i].targetUserId].score += scoreLogs[i].scoreChange;

      scoreByUserId[scoreLogs[i].targetUserId].scoresByReactions[scoreLogs[i].reaction] = scoreByUserId[scoreLogs[i].targetUserId].scoresByReactions[scoreLogs[i].reaction] || 0;
      scoreByUserId[scoreLogs[i].targetUserId].scoresByReactions[scoreLogs[i].reaction] += scoreLogs[i].scoreChange;
    }
  }

  const headers: any[] = [ "user", "score", "rank" ];
  const reactions = Object.keys(channelConfig.reactionsConfigs);
  for(let i=0; i<reactions.length; i++){
    headers.push("["+reactions[i]+"]'s points");
  }
  const scoresRows = [ headers ];


  const scores: UserScore[] = [];
  const uids = Object.keys(scoreByUserId);
  for(let i=0; i<uids.length; i++) {
    scores.push(scoreByUserId[uids[i]]);
  }
  scores.sort((a, b) => b.score - a.score);

  let currentRank = 0, previousScore = null;
  for(let i=0; i<scores.length; i++){
    if(scores[i].score !== previousScore) {
      currentRank++;
    }

    const row = [ scores[i].name, scores[i].score, currentRank ];
    for(let j=0; j<reactions.length; j++){
      row.push(scores[i].scoresByReactions[reactions[j]] || 0);
    }

    scoresRows.push(row);
    previousScore = scores[i].score;
  }

  return scoresRows;
}

function getUsersFrom(userData: string[][]): UsersById {
  const usersById: UsersById = {};
  for(let i=1; i<userData.length; i++){
    const uid = userData[i][0];
    usersById[uid] = { id: uid, name: userData[i][1] };
  }
  return usersById;
}

function getReactionLogsFrom(reactionLogsData): ReactionLog[] {
  const reactionLogs: ReactionLog[] = [];
  for(let i=1; i<reactionLogsData.length; i++){
    reactionLogs.push({
      date: reactionLogsData[i][0],
      issuerUserId: reactionLogsData[i][1],
      targetUserId: reactionLogsData[i][2],
      channel: reactionLogsData[i][3],
      reaction: reactionLogsData[i][4],
      type: reactionLogsData[i][5],
      threadId: reactionLogsData[i][6],
      threadAuthorUserId: reactionLogsData[i][7]
    });
  }
  return reactionLogs;
}
