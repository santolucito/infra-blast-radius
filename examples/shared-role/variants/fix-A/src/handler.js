// The reporting job only ever reads one object from the export bucket.
const AWS = require('aws-sdk');
const s3 = new AWS.S3();
exports.handler = async (event) =>
  (await s3.getObject({ Bucket: 'reports-export', Key: event.key }).promise()).Body.toString();
