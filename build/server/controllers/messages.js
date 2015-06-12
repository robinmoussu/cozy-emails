// Generated by CoffeeScript 1.9.1
var Account, AccountConfigError, BadRequest, ImapReporter, MSGBYPAGE, Mailbox, Message, NotFound, _, async, contentToBuffer, log, multiparty, normalizeMessageID, querystring, ref, stream_to_buffer, uuid,
  indexOf = [].indexOf || function(item) { for (var i = 0, l = this.length; i < l; i++) { if (i in this && this[i] === item) return i; } return -1; };

Message = require('../models/message');

Account = require('../models/account');

Mailbox = require('../models/mailbox');

ref = require('../utils/errors'), NotFound = ref.NotFound, BadRequest = ref.BadRequest, AccountConfigError = ref.AccountConfigError;

MSGBYPAGE = require('../utils/constants').MSGBYPAGE;

_ = require('lodash');

async = require('async');

querystring = require('querystring');

multiparty = require('multiparty');

stream_to_buffer = require('../utils/stream_to_array');

log = require('../utils/logging')({
  prefix: 'controllers:mesage'
});

normalizeMessageID = require('../utils/jwz_tools').normalizeMessageID;

ImapReporter = require('../imap/reporter');

uuid = require('uuid');

module.exports.fetch = function(req, res, next) {
  var id;
  id = req.params.messageID || req.body.id;
  return Message.find(id, function(err, found) {
    if (err) {
      return next(err);
    }
    if (!found) {
      return next(new NotFound("Message " + id));
    }
    req.message = found;
    return next();
  });
};

module.exports.fetchMaybe = function(req, res, next) {
  var id;
  id = req.body.id;
  if (id) {
    return module.exports.fetch(req, res, next);
  } else {
    return next();
  }
};

module.exports.details = function(req, res, next) {
  return res.send(req.message.toClientObject());
};

module.exports.attachment = function(req, res, next) {
  var encodedFileName, ref1, stream;
  stream = req.message.getBinary(req.params.attachment, function(err) {
    if (err) {
      return next(err);
    }
  });
  if ((ref1 = req.query) != null ? ref1.download : void 0) {
    encodedFileName = encodeURIComponent(req.params.attachment);
    res.setHeader('Content-disposition', "attachment; filename*=UTF8''" + encodedFileName);
  }
  return stream.pipe(res);
};

module.exports.listByMailboxOptions = function(req, res, next) {
  var FLAGS_CONVERT, after, before, descending, flag, flagcode, pageAfter, sort, sortField;
  sort = req.query.sort ? req.query.sort : '-date';
  descending = sort.substring(0, 1);
  if (descending === '+') {
    descending = false;
  } else if (descending === '-') {
    descending = true;
  } else {
    return next(new BadRequest("Unsuported sort order " + descending));
  }
  pageAfter = req.query.pageAfter;
  sortField = sort.substring(1);
  before = req.query.before;
  after = req.query.after;
  if (sortField === 'date') {
    if (before == null) {
      before = new Date(0).toISOString();
    }
    if (after == null) {
      after = new Date().toISOString();
    }
    if (new Date(before).toISOString() !== before || new Date(after).toISOString() !== after) {
      return next(new BadRequest("before & after should be a valid JS " + "date.toISOString()"));
    }
  } else if (sortField === 'from' || sortField === 'dest') {
    before = before ? decodeURIComponent(before) : '';
    after = after ? decodeURIComponent(after) : {};
    pageAfter = pageAfter ? decodeURIComponent(pageAfter) : void 0;
  } else {
    return next(new BadRequest("Unsuported sort field " + sortField));
  }
  FLAGS_CONVERT = {
    'seen': '\\Seen',
    'unseen': '!\\Seen',
    'flagged': '\\Flagged',
    'unflagged': '!\\Flagged',
    'answered': '\\Answered',
    'unanswered': '!\\Answered',
    'attach': '\\Attachments'
  };
  flagcode = req.query.flag;
  if (flagcode) {
    if (!(flag = FLAGS_CONVERT[flagcode])) {
      return next(new BadRequest("Unsuported flag filter"));
    }
  } else {
    flag = null;
  }
  req.sortField = sortField;
  req.descending = descending;
  req.before = before;
  req.sort = sort;
  req.after = after;
  req.pageAfter = pageAfter;
  req.flag = flag;
  req.flagcode = flagcode;
  return next();
};

module.exports.listByMailbox = function(req, res, next) {
  var mailboxID;
  mailboxID = req.params.mailboxID;
  return Message.getResultsAndCount(mailboxID, {
    sortField: req.sortField,
    descending: req.descending,
    before: req.before,
    after: req.after,
    resultsAfter: req.pageAfter,
    flag: req.flag
  }, function(err, result) {
    var last, lastDate, links, messages, pageAfter;
    if (err) {
      return next(err);
    }
    messages = result.messages;
    if (messages.length === MSGBYPAGE) {
      last = messages[messages.length - 1];
      if (req.sortField === 'from' || req.sortField === 'dest') {
        pageAfter = messages.length + (parseInt(req.pageAfter, 10) || 0);
      } else {
        lastDate = last.date || new Date();
        pageAfter = lastDate.toISOString();
      }
      links = {
        next: ("/mailbox/" + mailboxID + "?") + querystring.stringify({
          flag: req.flagcode,
          sort: req.sort,
          before: req.before,
          after: req.after,
          pageAfter: pageAfter
        })
      };
    } else {
      links = {};
    }
    if (result.messages == null) {
      result.messages = [];
    }
    result.mailboxID = mailboxID;
    result.messages = result.messages.map(function(msg) {
      return msg.toClientObject();
    });
    result.links = links;
    return res.send(result);
  });
};

module.exports.parseSendForm = function(req, res, next) {
  var fields, files, form, nextonce;
  form = new multiparty.Form({
    autoFields: true
  });
  nextonce = _.once(next);
  fields = {};
  files = {};
  form.on('field', function(name, value) {
    return fields[name] = value;
  });
  form.on('part', function(part) {
    stream_to_buffer(part, function(err, bufs) {
      if (err) {
        return nextonce(err);
      }
      return files[part.name] = {
        filename: part.filename,
        headers: part.headers,
        content: Buffer.concat(bufs)
      };
    });
    return part.resume();
  });
  form.on('error', function(err) {
    return nextonce(err);
  });
  form.on('close', function() {
    req.body = JSON.parse(fields.body);
    req.files = files;
    return nextonce();
  });
  return form.parse(req);
};

contentToBuffer = function(req, attachment, callback) {
  var bufferer, fileStream, filename;
  filename = attachment.generatedFileName;
  if (attachment.url) {
    fileStream = req.message.getBinary(filename, function(err) {
      if (err) {
        return log.error("Attachment streaming error", err);
      }
    });
    bufferer = new stream_to_buffer.Bufferer(callback);
    return fileStream.pipe(bufferer);
  } else if (req.files[filename]) {
    return callback(null, req.files[filename].content);
  } else {
    return callback(new BadRequest('Attachment #{filename} unknown'));
  }
};

module.exports.send = function(req, res, next) {
  var account, destination, draftBox, files, isDraft, isFwdAttachment, jdbMessage, message, previousUID, ref1, sentBox, steps, uidInDest;
  log.debug("send");
  message = req.body;
  account = req.account;
  files = req.files;
  if (message.attachments == null) {
    message.attachments = [];
  }
  message.flags = ['\\Seen'];
  isDraft = message.isDraft;
  delete message.isDraft;
  if (isDraft) {
    message.flags.push('\\Draft');
  }
  message.content = message.text;
  message.attachments_backup = message.attachments;
  if (message.conversationID == null) {
    message.conversationID = uuid.v4();
  }
  previousUID = (ref1 = message.mailboxIDs) != null ? ref1[account.draftMailbox] : void 0;
  isFwdAttachment = message.attachments.some(function(attachment) {
    return attachment.url && !req.message;
  });
  steps = [];
  if (isFwdAttachment) {
    steps.push(function(cb) {
      var id;
      log.debug("fetching forwarded original");
      id = message.inReplyTo;
      return Message.find(id, function(err, found) {
        if (err) {
          return cb(err);
        }
        if (!found) {
          return cb(new Error("Not Found Fwd " + id));
        }
        req.message = found;
        return cb(null);
      });
    });
  }
  steps.push(function(cb) {
    log.debug("gathering attachments");
    return async.mapSeries(message.attachments, function(attachment, cbMap) {
      return contentToBuffer(req, attachment, function(err, content) {
        if (err) {
          return cbMap(err);
        }
        return cbMap(null, {
          content: content,
          filename: attachment.fileName,
          cid: attachment.contentId,
          contentType: attachment.contentType,
          contentDisposition: attachment.contentDisposition
        });
      });
    }, function(err, cacheds) {
      if (err) {
        return cb(err);
      }
      message.attachments = cacheds;
      return cb();
    });
  });
  draftBox = null;
  sentBox = null;
  destination = null;
  jdbMessage = null;
  uidInDest = null;
  if (!isDraft) {
    steps.push(function(cb) {
      log.debug("send#sending");
      return account.sendMessage(message, function(err, info) {
        if (err) {
          return cb(err);
        }
        message.headers['message-id'] = info.messageId;
        message.messageID = normalizeMessageID(info.messageId);
        return cb(null);
      });
    });
    steps.push(function(cb) {
      var id;
      log.debug("send#getsentbox");
      id = account.sentMailbox;
      return Mailbox.find(id, function(err, box) {
        if (err) {
          return cb(err);
        }
        if (!box) {
          err = new NotFound("Account " + account.id + " sentbox " + id);
          return cb(err);
        }
        sentBox = box;
        return cb();
      });
    });
  }
  if (previousUID || isDraft) {
    steps.push(function(cb) {
      var id;
      log.debug("send#getdraftbox");
      id = account.draftMailbox;
      return Mailbox.find(id, function(err, box) {
        if (err) {
          return cb(err);
        }
        if (!box) {
          err = new NotFound("Account " + account.id + " draftbox " + id);
          return cb(err);
        }
        draftBox = box;
        return cb();
      });
    });
  }
  if (previousUID) {
    steps.push(function(cb) {
      log.debug("send#remove_old");
      return draftBox.imap_removeMail(previousUID, cb);
    });
  }
  if (isDraft) {
    steps.push(function(cb) {
      destination = draftBox;
      log.debug("send#add_to_draft");
      return account.imap_createMail(draftBox, message, function(err, uid) {
        if (err) {
          return cb(err);
        }
        uidInDest = uid;
        return cb(null);
      });
    });
  } else {
    log.debug("send#add_to_sent");
    steps.push(function(cb) {
      destination = sentBox;
      return sentBox.imap_createMailNoDuplicate(account, message, function(err, uid) {
        if (err) {
          return cb(err);
        }
        uidInDest = uid;
        return cb(null);
      });
    });
  }
  steps.push(function(cb) {
    log.debug("send#cozy_create");
    message.attachments = message.attachments_backup;
    message.text = message.content;
    delete message.attachments_backup;
    delete message.content;
    if (account.isTest()) {
      uidInDest = Date.now();
    }
    message.mailboxIDs = {};
    message.mailboxIDs[destination.id] = uidInDest;
    message.date = new Date().toISOString();
    return Message.updateOrCreate(message, function(err, updated) {
      if (err) {
        return cb(err);
      }
      jdbMessage = updated;
      return cb(null);
    });
  });
  if (isFwdAttachment) {
    steps.push(function(cb) {
      var attachment, binary, filename, i, len, ref2;
      log.debug("send#linking");
      binary = {};
      ref2 = message.attachments;
      for (i = 0, len = ref2.length; i < len; i++) {
        attachment = ref2[i];
        filename = attachment.generatedFileName;
        if (filename in req.message.binary) {
          binary[filename] = req.message.binary[filename];
        }
      }
      return jdbMessage.updateAttributes({
        binary: binary
      }, cb);
    });
  }
  steps.push(function(cb) {
    log.debug("send#attaching");
    return async.eachSeries(Object.keys(files), function(name, cbLoop) {
      var buffer;
      buffer = files[name].content;
      buffer.path = encodeURI(name);
      return jdbMessage.attachBinary(buffer, {
        name: name
      }, cbLoop);
    }, cb);
  });
  steps.push(function(cb) {
    var remainingAttachments;
    log.debug("send#removeBinary");
    if (jdbMessage.binary == null) {
      jdbMessage.binary = {};
    }
    remainingAttachments = jdbMessage.attachments.map(function(file) {
      return file.generatedFileName;
    });
    return async.eachSeries(Object.keys(jdbMessage.binary), function(name, cbLoop) {
      if (indexOf.call(remainingAttachments, name) >= 0) {
        return cbLoop(null);
      } else {
        return jdbMessage.removeBinary(name, cbLoop);
      }
    }, cb);
  });
  return async.series(steps, function(err) {
    var out;
    if (err) {
      return next(err);
    }
    if (!jdbMessage) {
      return next(new Error('Server error'));
    }
    out = jdbMessage.toClientObject();
    out.isDraft = isDraft;
    return res.send(out);
  });
};

module.exports.batchFetch = function(req, res, next) {
  var handleMessages;
  if (Object.keys(req.body).length === 0) {
    req.body = req.query;
  }
  handleMessages = function(err, messages) {
    if (err) {
      return next(err);
    }
    req.messages = messages;
    return next();
  };
  if (req.body.messageID) {
    return Message.find(req.body.messageID, function(err, message) {
      return handleMessages(err, [message]);
    });
  } else if (req.body.conversationID) {
    return Message.byConversationID(req.body.conversationID, handleMessages);
  } else if (req.body.messageIDs) {
    return Message.findMultiple(req.body.messageIDs, handleMessages);
  } else if (req.body.conversationIDs) {
    return Message.byConversationIDs(req.body.conversationIDs, handleMessages);
  } else {
    return next(new BadRequest("No conversationIDs, conversationID, or messageIDs in body."));
  }
};

module.exports.batchSend = function(req, res, next) {
  var messages;
  messages = req.messages.filter(function(msg) {
    return msg != null;
  }).map(function(msg) {
    return msg != null ? msg.toClientObject() : void 0;
  });
  if (messages.length === 0) {
    return next(new NotFound("No message found"));
  }
  return res.send(messages);
};

module.exports.batchTrash = function(req, res, next) {
  var trashBoxId;
  trashBoxId = req.account.trashMailbox;
  if (!trashBoxId) {
    return next(new AccountConfigError('trashMailbox'));
  }
  return Message.batchTrash(req.messages, trashBoxId, function(err, updated) {
    if (err) {
      return next(err);
    }
    return res.send(updated);
  });
};

module.exports.batchAddFlag = function(req, res, next) {
  return Message.batchAddFlag(req.messages, req.body.flag, function(err, updated) {
    if (err) {
      return next(err);
    }
    return res.send(updated);
  });
};

module.exports.batchRemoveFlag = function(req, res, next) {
  return Message.batchRemoveFlag(req.messages, req.body.flag, function(err, updated) {
    if (err) {
      return next(err);
    }
    return res.send(updated);
  });
};

module.exports.batchMove = function(req, res, next) {
  var from, to;
  to = req.body.to;
  from = req.body.from;
  return Message.batchMove(req.messages, from, to, function(err, updated) {
    if (err) {
      return next(err);
    }
    return res.send(updated);
  });
};

module.exports.raw = function(req, res, next) {
  var boxID, uid;
  boxID = Object.keys(req.message.mailboxIDs)[0];
  uid = req.message.mailboxIDs[boxID];
  return Mailbox.find(boxID, function(err, mailbox) {
    if (err) {
      return next(err);
    }
    return mailbox.doASAPWithBox(function(imap, imapbox, cbRelease) {
      try {
        return imap.fetchOneMailRaw(uid, cbRelease);
      } catch (_error) {
        err = _error;
        return cbRelease(err);
      }
    }, function(err, message) {
      if (err) {
        return next(err);
      }
      res.type('text/plain');
      return res.send(message);
    });
  });
};
