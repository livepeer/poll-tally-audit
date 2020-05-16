require("dotenv").config();
const { createApolloFetch } = require("apollo-fetch");
const assert = require("assert");
const Web3 = require("web3");
const Table = require("cli-table");
const ora = require("ora");
const cliSpinners = require("cli-spinners");

const RoundsManagerABI = require("../abis/RoundsManager.json");
const BondingManagerABI = require("../abis/BondingManager.json");
const PollABI = require("../abis/Poll.json");

const roundsManagerAddress = "0x3984fc4ceeef1739135476f625d36d6c35c40dc3";
const bondingManagerAddress = "0x511bc4556d823ae99630ae8de28b9b80df90ea2e";

const web3 = new Web3(process.env.WEB3_PROVIDER);

const defaults = { gas: 10000000 };

const RoundsManager = new web3.eth.Contract(
  RoundsManagerABI,
  roundsManagerAddress,
  defaults
);
const BondingManager = new web3.eth.Contract(
  BondingManagerABI,
  bondingManagerAddress,
  defaults
);

const Poll = new web3.eth.Contract(PollABI, process.env.POLL_ADDRESS, defaults);

const fetchSubgraph = createApolloFetch({
  uri: `https://api.thegraph.com/subgraphs/name/livepeer/livepeer`,
});

let isActive = false;
let endBlock;
let latestBlockNumber;
let subgraphPollData;
let spinner;

const getStake = async (addr) => {
  const currentRound = await RoundsManager.methods
    .currentRound()
    .call({}, isActive ? latestBlockNumber : endBlock);
  return await BondingManager.methods
    .pendingStake(addr, currentRound)
    .call({}, isActive ? latestBlockNumber : endBlock);
};

const tallyPollAndCheckResult = async (voters) => {
  let yesTally = new web3.utils.BN(0);
  let noTally = new web3.utils.BN(0);

  for (voter in voters) {
    let voteStake = await getStake(voter);
    let nonVoteStake = new web3.utils.BN(0);

    if ("choiceID" in voters[voter]) {
      if (voters[voter].registeredTranscoder) {
        let delegatorData = await BondingManager.methods
          .getDelegator(voter)
          .call({}, isActive ? latestBlockNumber : endBlock);

        voteStake = delegatorData.delegatedAmount;

        if (voters[voter].overrides.length) {
          for (const override of voters[voter].overrides) {
            let overrideVoteStake = await getStake(override);
            nonVoteStake = nonVoteStake.add(
              new web3.utils.BN(overrideVoteStake)
            );
          }
        }
      }

      if (voters[voter].choiceID == 0) {
        yesTally = new web3.utils.BN(yesTally)
          .add(new web3.utils.BN(voteStake).sub(nonVoteStake))
          .toString(10);
      }

      if (voters[voter].choiceID == 1) {
        noTally = new web3.utils.BN(noTally)
          .add(new web3.utils.BN(voteStake).sub(nonVoteStake))
          .toString(10);
      }
    }
  }

  spinner.stop();

  const table = new Table({
    style: { head: ["cyan"] },
    head: ["", "Yes", "No"],
  });

  table.push(
    {
      Subgraph: [
        subgraphPollData.data.poll.tally
          ? subgraphPollData.data.poll.tally.yes
          : "0",
        subgraphPollData.data.poll.tally
          ? subgraphPollData.data.poll.tally.no
          : "0",
      ],
    },
    { Node: [yesTally, noTally] }
  );

  console.log(table.toString());

  assert.equal(
    subgraphPollData.data.poll.tally
      ? subgraphPollData.data.poll.tally.yes
      : "0",
    yesTally,
    "incorrect yes tally"
  );

  assert.equal(
    subgraphPollData.data.poll.tally
      ? subgraphPollData.data.poll.tally.no
      : "0",
    noTally,
    "incorrect no tally"
  );
};

describe("Livepeer Poll Tally Audit\n", function () {
  this.enableTimeouts(false);

  before(async () => {
    spinner = ora(cliSpinners.dots).start();
    spinner.text = "Running";
    spinner.indent = 2;

    latestBlockNumber = await web3.eth.getBlockNumber();
    endBlock = +(await Poll.methods.endBlock().call());
    if (latestBlockNumber < endBlock) {
      isActive = true;
    }

    // If running audit while poll is active, make sure to get poll tally 10 blocks
    // prior to latest in case the subgraph is in the middle of running updates
    latestBlockNumber = latestBlockNumber - 10;

    subgraphPollData = await fetchSubgraph({
      query: `{
        poll(block: {number: ${isActive ? latestBlockNumber : endBlock}} id: "${
        process.env.POLL_ADDRESS
      }") {
          tally {
            yes
            no
          }
          votes {
            voter
            choiceID
            registeredTranscoder
          }
        }
      }`,
    });
  });

  it("subgraph correctly tallies poll", async () => {
    let voters = {};
    for (const vote of subgraphPollData.data.poll.votes) {
      voters[vote.voter] = {
        choiceID: vote.choiceID === "Yes" ? 0 : 1,
        overrides: [],
        ...voters[vote.voter],
      };

      let transcoderStatus = await BondingManager.methods
        .transcoderStatus(vote.voter)
        .call({}, isActive ? latestBlockNumber : endBlock);

      if (transcoderStatus === "1") {
        voters[vote.voter].registeredTranscoder = true;
      } else {
        let delegator = await BondingManager.methods
          .getDelegator(vote.voter)
          .call({}, isActive ? latestBlockNumber : endBlock);

        voters[vote.voter].registeredTranscoder = false;

        if (
          typeof voters[delegator.delegateAddress.toLowerCase()] === "undefined"
        ) {
          voters[delegator.delegateAddress.toLowerCase()] = {
            overrides: [vote.voter],
          };
        } else {
          voters[delegator.delegateAddress.toLowerCase()].overrides.push(
            vote.voter
          );
        }
      }
    }
    await tallyPollAndCheckResult(voters);
  });
});
