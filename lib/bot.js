import _ from 'lodash';
import irc from 'irc';
import logger from 'winston';
import discord from 'discord.js';
import { ConfigurationError } from './errors';
import { validateChannelMapping } from './validators';

const REQUIRED_FIELDS = ['server', 'nickname', 'channelMapping', 'discordToken'];
const NICK_COLORS = ['light_blue', 'dark_blue', 'light_red', 'dark_red', 'light_green',
  'dark_green', 'magenta', 'light_magenta', 'orange', 'yellow', 'cyan', 'light_cyan'];

/**
 * An IRC bot, works as a middleman for all communication
 * @param {object} options - server, nickname, channelMapping, outgoingToken, incomingURL
 */
class Bot {
  constructor(options) {
    REQUIRED_FIELDS.forEach(field => {
      if (!options[field]) {
        throw new ConfigurationError(`Missing configuration field ${field}`);
      }
    });

    validateChannelMapping(options.channelMapping);

    this.discord = new discord.Client({ autoReconnect: true });

    this.server = options.server;
    this.nickname = options.nickname;
    this.ircOptions = options.ircOptions;
    this.discordToken = options.discordToken;
    this.commandCharacters = options.commandCharacters || [];
    this.ircNickColor = options.ircNickColor !== false; // default to true
    this.channels = _.values(options.channelMapping);

    this.channelMapping = {};

    // Remove channel passwords from the mapping and lowercase IRC channel names
    _.forOwn(options.channelMapping, (ircChan, discordChan) => {
      this.channelMapping[discordChan] = ircChan.split(' ')[0].toLowerCase();
    });

    this.invertedMapping = _.invert(this.channelMapping);
    this.autoSendCommands = options.autoSendCommands || [];
  }

  connect() {
    logger.debug('Connecting to IRC and Discord');
    this.discord.loginWithToken(this.discordToken);

    const ircOptions = {
      userName: this.nickname,
      realName: this.nickname,
      channels: this.channels,
      floodProtection: true,
      floodProtectionDelay: 500,
      retryCount: 10,
      ...this.ircOptions
    };

    this.ircClient = new irc.Client(this.server, this.nickname, ircOptions);
    this.attachListeners();
  }

  attachListeners() {
    this.discord.on('ready', () => {
      logger.debug('Connected to Discord');
    });

    this.ircClient.on('registered', message => {
      logger.debug('Registered event: ', message);
      this.autoSendCommands.forEach(element => {
        this.ircClient.send(...element);
      });
    });

    this.ircClient.on('error', error => {
      logger.error('Received error event from IRC', error);
    });

    this.discord.on('error', error => {
      logger.error('Received error event from Discord', error);
    });

    this.discord.on('message', message => {
      // Ignore bot messages and people leaving/joining
      this.sendToIRC(message);
    });

    this.ircClient.on('message', this.sendToDiscord.bind(this));

    this.ircClient.on('notice', (author, to, text) => {
      this.sendToDiscord(author, to, `*${text}*`);
    });

    this.ircClient.on('action', (author, to, text) => {
      this.sendToDiscord(author, to, `_${text}_`);
    });

    this.ircClient.on('invite', (channel, from) => {
      logger.debug('Received invite:', channel, from);
      if (!this.invertedMapping[channel]) {
        logger.debug('Channel not found in config, not joining:', channel);
      } else {
        this.ircClient.join(channel);
        logger.debug('Joining channel:', channel);
      }
    });
  }

  parseText(message) {
    const text = message.mentions.reduce((content, mention) => (
      content.replace(`<@${mention.id}>`, `@${mention.username}`)
             .replace(`<@!${mention.id}>`, `@${mention.username}`)
    ), message.content);

    return text
      .replace(/\n|\r\n|\r/g, ' ')
      .replace(/<#(\d+)>/g, (match, channelId) => {
        const channel = this.discord.channels.get('id', channelId);
        return `#${channel.name}`;
      });
  }

  isCommandMessage(message) {
    return this.commandCharacters.indexOf(message[0]) !== -1;
  }

  sendToIRC(message) {
    const author = message.author;
    // Ignore messages sent by the bot itself:
    if (author.id === this.discord.user.id) return;

    const channelName = `#${message.channel.name}`;
    const ircChannel = this.channelMapping[channelName];

    logger.debug('Channel Mapping', channelName, this.channelMapping[channelName]);
    if (ircChannel) {
      const username = author.username;
      let text = this.parseText(message);
      let displayUsername = username;
      if (this.ircNickColor) {
        const colorIndex = (username.charCodeAt(0) + username.length) % NICK_COLORS.length;
        displayUsername = irc.colors.wrap(NICK_COLORS[colorIndex], username);
      }

      if (this.isCommandMessage(text)) {
        const prelude = `Command sent from Discord by ${username}: (mtib version)`;
        this.ircClient.say(ircChannel, prelude);
        this.ircClient.say(ircChannel, text.substring(1));
      } else {
        if (text !== '') {
          text = `<${displayUsername}> ${text}`;
          logger.debug('Sending message to IRC', ircChannel, text);
          this.ircClient.say(ircChannel, text);
        }

        if (message.attachments && message.attachments.length) {
          message.attachments.forEach(a => {
            const urlMessage = `<${displayUsername}> ${a.url}`;
            logger.debug('Sending attachment URL to IRC', ircChannel, urlMessage);
            this.ircClient.say(ircChannel, urlMessage);
          });
        }
      }
    }
  }

  sendToDiscord(author, channel, text) {
    const discordChannelName = this.invertedMapping[channel.toLowerCase()];
    if (discordChannelName) {
      // #channel -> channel before retrieving:
      const discordChannel = this.discord.channels.get('name', discordChannelName.slice(1));

      if (!discordChannel) {
        logger.info('Tried to send a message to a channel the bot isn\'t in: ',
          discordChannelName);
        return;
      }

      const withMentions = text.replace(/@[^\s]+\b/g, match => {
        const user = this.discord.users.get('username', match.substring(1));
        return user ? user.mention() : match;
      });

      // Add bold formatting:
      const withAuthor = `**<${author}>** ${withMentions}`;
      logger.debug('Sending message to Discord', withAuthor, channel, '->', discordChannelName);
      this.discord.sendMessage(discordChannel, withAuthor);
    }
  }
}

export default Bot;
