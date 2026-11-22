import axios from 'axios';

module.exports = async function () {
  const host = process.env['HOST'] ?? 'localhost';
  const port = process.env['API_PORT'] ?? '3100';
  axios.defaults.baseURL = `http://${host}:${port}`;
};
