'use strict'

const async = require('async')
const config = require('config')
const fs = require('fs')
const request = require('request')

const constants = require('../initializers/constants')
const logger = require('../helpers/logger')
const peertubeCrypto = require('../helpers/peertubeCrypto')
const Pods = require('../models/pods')
const requestsScheduler = require('../lib/requestsScheduler')
const requests = require('../helpers/requests')
const videos = require('../lib/videos')
const Videos = require('../models/videos')

const http = config.get('webserver.https') ? 'https' : 'http'
const host = config.get('webserver.host')
const port = config.get('webserver.port')

const pods = {
  addVideoToFriends: addVideoToFriends,
  hasFriends: hasFriends,
  getMyCertificate: getMyCertificate,
  makeFriends: makeFriends,
  quitFriends: quitFriends,
  removeVideoToFriends: removeVideoToFriends
}

function addVideoToFriends (video) {
  // To avoid duplicates
  const id = video.name + video.magnetUri
  // ensure namePath is null
  video.namePath = null
  requestsScheduler.addRequest(id, 'add', video)
}

function hasFriends (callback) {
  Pods.count(function (err, count) {
    if (err) return callback(err)

    const has_friends = (count !== 0)
    callback(null, has_friends)
  })
}

function getMyCertificate (callback) {
  fs.readFile(peertubeCrypto.getCertDir() + 'peertube.pub', 'utf8', callback)
}

function makeFriends (callback) {
  const pods_score = {}

  logger.info('Make friends!')
  getMyCertificate(function (err, cert) {
    if (err) {
      logger.error('Cannot read public cert.')
      return callback(err)
    }

    const urls = config.get('network.friends')

    async.each(urls, function (url, callback_each) {
      computeForeignPodsList(url, pods_score, callback_each)
    }, function (err) {
      if (err) return callback(err)

      logger.debug('Pods scores computed.', { pods_score: pods_score })
      const pods_list = computeWinningPods(urls, pods_score)
      logger.debug('Pods that we keep.', { pods_to_keep: pods_list })

      makeRequestsToWinningPods(cert, pods_list, callback)
    })
  })
}

function quitFriends (callback) {
  // Stop pool requests
  requestsScheduler.deactivate()
  // Flush pool requests
  requestsScheduler.forceSend()

  Pods.list(function (err, pods) {
    if (err) return callback(err)

    const request = {
      method: 'POST',
      path: '/api/' + constants.API_VERSION + '/pods/remove',
      sign: true,
      encrypt: true,
      data: {
        url: 'me' // Fake data
      }
    }

    // Announce we quit them
    requests.makeMultipleRetryRequest(request, pods, function () {
      Pods.removeAll(function (err) {
        requestsScheduler.activate()

        if (err) return callback(err)

        logger.info('Broke friends, so sad :(')

        Videos.listFromRemotes(function (err, videos_list) {
          if (err) return callback(err)

          videos.removeRemoteVideos(videos_list, function (err) {
            if (err) {
              logger.error('Cannot remove remote videos.', { error: err })
              return callback(err)
            }

            logger.info('Removed all remote videos.')
            callback(null)
          })
        })
      })
    })
  })
}

function removeVideoToFriends (video) {
  // To avoid duplicates
  const id = video.name + video.magnetUri
  requestsScheduler.addRequest(id, 'remove', video)
}

// ---------------------------------------------------------------------------

module.exports = pods

// ---------------------------------------------------------------------------

function computeForeignPodsList (url, pods_score, callback) {
  // Let's give 1 point to the pod we ask the friends list
  pods_score[url] = 1

  getForeignPodsList(url, function (err, foreign_pods_list) {
    if (err) return callback(err)
    if (foreign_pods_list.length === 0) return callback()

    foreign_pods_list.forEach(function (foreign_pod) {
      const foreign_url = foreign_pod.url

      if (pods_score[foreign_url]) pods_score[foreign_url]++
      else pods_score[foreign_url] = 1
    })

    callback()
  })
}

function computeWinningPods (urls, pods_score) {
  // Build the list of pods to add
  // Only add a pod if it exists in more than a half base pods
  const pods_list = []
  const base_score = urls.length / 2
  Object.keys(pods_score).forEach(function (pod) {
    if (pods_score[pod] > base_score) pods_list.push({ url: pod })
  })

  return pods_list
}

function getForeignPodsList (url, callback) {
  const path = '/api/' + constants.API_VERSION + '/pods'

  request.get(url + path, function (err, response, body) {
    if (err) return callback(err)

    callback(null, JSON.parse(body))
  })
}

function makeRequestsToWinningPods (cert, pods_list, callback) {
  // Stop pool requests
  requestsScheduler.deactivate()
  // Flush pool requests
  requestsScheduler.forceSend()

  // Get the list of our videos to send to our new friends
  Videos.listOwned(function (err, videos_list) {
    if (err) {
      logger.error('Cannot get the list of videos we own.')
      return callback(err)
    }

    const data = {
      url: http + '://' + host + ':' + port,
      publicKey: cert,
      videos: videos_list
    }

    requests.makeMultipleRetryRequest(
      { method: 'POST', path: '/api/' + constants.API_VERSION + '/pods/', data: data },

      pods_list,

      function eachRequest (err, response, body, url, pod, callback_each_request) {
        // We add the pod if it responded correctly with its public certificate
        if (!err && response.statusCode === 200) {
          Pods.add({ url: pod.url, publicKey: body.cert, score: constants.FRIEND_BASE_SCORE }, function (err) {
            if (err) {
              logger.error('Error with adding %s pod.', pod.url, { error: err })
              return callback_each_request()
            }
            console.log('hihi')
            videos.createRemoteVideos(body.videos, function (err) {
              if (err) {
                logger.error('Error with adding videos of pod.', pod.url, { error: err })
                return callback_each_request()
              }

              console.log('kik')

              logger.debug('Adding remote videos from %s.', pod.url, { videos: body.videos })
              return callback_each_request()
            })
          })
        } else {
          logger.error('Error with adding %s pod.', pod.url, { error: err || new Error('Status not 200') })
          return callback_each_request()
        }
      },

      function endRequests (err) {
        // Now we made new friends, we can re activate the pool of requests
        requestsScheduler.activate()

        if (err) {
          logger.error('There was some errors when we wanted to make friends.')
          return callback(err)
        }

        logger.debug('makeRequestsToWinningPods finished.')
        return callback(null)
      }
    )
  })
}
