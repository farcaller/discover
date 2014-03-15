/*!
 * Totem Discover
 * Copyright(c) 2013 Meltmedia <mike@meltmedia.com>
 * MIT Licensed
 */

'use strict';

var winston = require('winston'),
    dockerClient = require('docker.io'),
    events = require('events'),
    util = require('util');


module.exports = Docker;


function Docker(config) {
  if (!(this instanceof Docker)) {
    return new Docker(config);
  }

  if (!config ||
      !config.host || !config.host.ip || !config.host.realm ||
      !config.docker) {
    throw new Error('Invalid configuration, you must provide valid `host` and `docker` configuration blocks');
  }

  this.config = config;

  this.docker = dockerClient(this.config.docker);

  this.serviceVariableMatcher = new RegExp('^' + this.config.discover.serviceVariable + '=(.*)$');

  // Setup host specific configuration
  this.hostIp = this.config.host.ip;
  this.hostRealm = this.config.host.realm;

  this.docker.version(function (err, res) {
    winston.debug('Docker version: ' + JSON.stringify(res));
  });
}

// Make Docker an EventEmitter
util.inherits(Docker, events.EventEmitter);

Docker.prototype.events = function (cb) {
  this.docker.events(function (err, res) {
    if (err) {
      winston.error('An error occured streaming events from Docker: ' + err);
      return cb(err);
    }

    res.on('data', function (event) {
      var parsedEvent;
      try {
        parsedEvent = JSON.parse(event);
        // Trim the id if needed
        parsedEvent.id = (parsedEvent.id.length > 12) ? parsedEvent.id.slice(0, 12) : parsedEvent.id;

        winston.debug('Docker event: ' + parsedEvent.status + ' - ' + parsedEvent.id + ' - ' + parsedEvent.from);
      } catch (e) {
        var message = 'Unable to parse Docker event: ' + util.inspect(event, {depth: 4, colors: true}) + ' due to: ' + e;
        winston.warn(message);
        return cb(new Error(message));
      }

      cb(null, parsedEvent);
    });

    res.on('end', function () {
      cb(new Error('Docker event stream closed'));
    });
  });
};

Docker.prototype.runningContainers = function (cb) {
  this.docker.containers.list(function (err, containers) {
    if (err) {
      winston.error('An error occured getting container list from Docker: ' + err);
      return cb(err);
    }

    var containerIds = [];
    if (containers) {
      containers.forEach(function (item) {
        var id = (item.Id.length === 64) ? item.Id.slice(0, 12) : item.Id;
        containerIds.push(id);
      });
    }

    cb(err, containerIds);
  });
};

Docker.prototype.publishedServices = function (id, cb) {
  var self = this;

  this.docker.containers.inspect(id, function (err, container) {
    var services = [];

    if (err) {
      winston.error('Unable to lookup published services for container due to: ' + err);
      return cb(err);
    }

    if (!container) {
      err = 'Unable to find container for id: ' + id;
      winston.warn(err);
      return cb(new Error(err));
    }

    if (!container.State.Running) {
      err = 'Unable to lookup published services for containers that are not running';
      winston.warn(err);
      return cb(new Error(err));
    }

    winston.log('silly', 'Container: ' + JSON.stringify(container, null, '  '));

    // Look for the 'DISCOVER' environment variable of published services
    if (container.Config && container.Config.Env) {
      container.Config.Env.forEach(function (env) {
        if (env.match(self.serviceVariableMatcher)) {
          var serviceDescriptors = env.replace(self.serviceVariableMatcher, '$1').split(',');

          serviceDescriptors.forEach(function (item) {
            try {
              var parts = item.trim().split(':'),
                  name = parts[0],
                  port = parts[1],
                  protocol = 'tcp',
                  location = null;

              location = container.NetworkSettings.IPAddress + ':' + port;

              services.push({
                name: name,
                containerId: id,
                location: location,
                realm: self.hostRealm
              });

            } catch (e) {
              // @todo: should we silently ignore this?
              var message = 'There was an issue discovering services for: ' + id + ' with service descriptor: ' + item + ' due to: ' + e;
              winston.error(message);
            }
          });

        }
      });
    }
    cb(null, services);
  });
};
