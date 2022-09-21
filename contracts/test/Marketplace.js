const { expect } = require("chai")
const { ethers } = require("hardhat")
const { MerkleTree } = require('merkletreejs')
const keccak256 = require("keccak256")
const Hash = require('pure-ipfs-only-hash')
const { toUsdc, fromUsdc, toEther, fromEther, getBalance } = require("./Helpers")

// contracts
let marketplace

// mocks
let erc1155
let erc721
let mockUsdc

// accounts
let admin
let alice
let bob
let dev

describe("Marketplace contract", () => {

    beforeEach(async () => {
        [admin, alice, bob, relayer, dev] = await ethers.getSigners()

        const Marketplace = await ethers.getContractFactory("Marketplace")
        const MockERC1155 = await ethers.getContractFactory("MockERC1155")
        const MockERC20 = await ethers.getContractFactory("MockERC20")

        marketplace = await Marketplace.deploy(1)

        erc1155 = await MockERC1155.deploy(
            "https://api.cryptokitties.co/kitties/{id}"
        )
        mockUsdc = await MockERC20.deploy("Mock USDC", "USDC", 6)
    })


    it("NFT -> NFT", async () => {

        // mint ERC-1155
        await erc1155.mint(alice.address, 1, 1, "0x00")
        await erc1155.mint(bob.address, 2, 1, "0x00")

        // make approvals
        await erc1155.connect(alice).setApprovalForAll(marketplace.address, true)
        await erc1155.connect(bob).setApprovalForAll(marketplace.address, true)

        const CIDS = await Promise.all(["Order#1", "Order#2"].map(item => Hash.of(item)))

        // Alice accepts NFT ID 2 for NFT ID 1
        const leaves = [erc1155].map((item, index) => ethers.utils.keccak256(ethers.utils.solidityPack(["string", "uint256", "address", "uint256"], [index === 0 ? CIDS[0] : CIDS[1], 1, item.address, 2])))
        const tree = new MerkleTree(leaves, keccak256, { sortPairs: true })

        const hexRoot = tree.getHexRoot()

        await marketplace.connect(alice).create(CIDS[0], erc1155.address, 1, 1, hexRoot)

        // verify
        const firstOrder = await marketplace.orders(CIDS[0])
        expect(firstOrder['assetAddress']).to.equal(erc1155.address)
        expect(firstOrder['tokenId'].toString()).to.equal("1")
        expect(firstOrder['tokenType']).to.equal(1)
        expect(firstOrder['owner']).to.equal(alice.address)

        // check whether Bob can swaps
        const proof = tree.getHexProof(ethers.utils.keccak256(ethers.utils.solidityPack(["string", "uint256", "address", "uint256"], [CIDS[0], 1, erc1155.address, 2])))

        expect(await marketplace.connect(bob).eligibleToSwap(
            CIDS[0],
            erc1155.address,
            2,
            firstOrder['root'],
            proof
        )).to.true

        // swap
        // Token 2 -> Token 1
        await marketplace.connect(bob).swap(CIDS[0], erc1155.address, 2, 1, proof)

        // Alice should receives Token 2
        expect(await erc1155.balanceOf(alice.address, 2)).to.equal(1)
        // Bob should receives Token 1
        expect(await erc1155.balanceOf(bob.address, 1)).to.equal(1)
    })

    it("NFT -> ERC-20", async () => {
        // mint NFT to Alice
        await erc1155.mint(alice.address, 1, 1, "0x00")
        // Prepare ERC-20 for Bob
        await mockUsdc.connect(bob).faucet()

        // make approvals
        await erc1155.connect(alice).setApprovalForAll(marketplace.address, true)
        await mockUsdc.connect(bob).approve(marketplace.address, ethers.constants.MaxUint256)

        const cid = await Hash.of("Order#1")

        const leaves = [ethers.utils.keccak256(ethers.utils.solidityPack(["string", "uint256", "address", "uint256"], [cid, 1, mockUsdc.address, toUsdc(200)]))]

        const tree = new MerkleTree(leaves, keccak256, { sortPairs: true })

        const root = tree.getHexRoot()

        // create an order and deposit ERC721 NFT
        await marketplace.connect(alice).create(cid, erc1155.address, 1, 1, root)

        const proof = tree.getHexProof(ethers.utils.keccak256(ethers.utils.solidityPack(["string", "uint256", "address", "uint256"], [cid, 1, mockUsdc.address, toUsdc(200)])))

        expect(await marketplace.connect(bob).eligibleToSwap(
            cid,
            mockUsdc.address,
            toUsdc(200),
            (await marketplace.orders(cid))['root'],
            proof
        )).to.true

        const before = await mockUsdc.balanceOf(bob.address)

        // swap 200 USDC for 1 NFT
        await marketplace.connect(bob).swap(cid, mockUsdc.address, toUsdc(200), 0, proof)

        const after = await mockUsdc.balanceOf(bob.address)

        expect(Number(fromUsdc(before)) - Number(fromUsdc(after))).to.equal(200)

        // validate the result
        expect(await erc1155.balanceOf(bob.address, 1)).to.equal(1)
        expect(await mockUsdc.balanceOf(alice.address)).to.equal(toUsdc(194))

    })

    it("NFT -> ETH", async () => {

        // mint ERC-1155 for Alice
        await erc1155.mint(alice.address, 1, 1, "0x00")

        // make approvals
        await erc1155.connect(alice).setApprovalForAll(marketplace.address, true)

        const cid = await Hash.of("Order#1")

        const leaves = [ethers.utils.keccak256(ethers.utils.solidityPack(["string", "uint256", "address", "uint256"], [cid, 1, "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", toEther(0.1)]))]

        const tree = new MerkleTree(leaves, keccak256, { sortPairs: true })

        const root = tree.getHexRoot()

        // list the NFT
        await marketplace.connect(alice).create(cid, erc1155.address, 1, 1, root)

        const proof = tree.getHexProof(ethers.utils.keccak256(ethers.utils.solidityPack(["string", "uint256", "address", "uint256"], [cid, 1, "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", toEther(0.1)])))

        // swap 0.1 ETH for 1 NFT
        await marketplace.connect(bob).swapWithEth(cid, proof, {
            value: toEther(0.1)
        })

        // validate the result
        expect(await erc1155.balanceOf(bob.address, 1)).to.equal(1)
    })

    it("NFT -> FIAT", async () => {

        // mint ERC-1155 for Alice
        await erc1155.mint(alice.address, 1, 1, "0x00")

        // make approvals
        await erc1155.connect(alice).setApprovalForAll(marketplace.address, true)

        const cid = await Hash.of("Order#1")

        const leaves = [ethers.utils.keccak256(ethers.utils.solidityPack(["string", "uint256", "address", "uint256"], [cid, 1, "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", toEther(10)]))]

        const tree = new MerkleTree(leaves, keccak256, { sortPairs: true })

        const root = tree.getHexRoot()

        // list the NFT
        await marketplace.connect(alice).create(cid, erc1155.address, 1, 1, root)

        const proof = tree.getHexProof(ethers.utils.keccak256(ethers.utils.solidityPack(["string", "uint256", "address", "uint256"], [cid, 1, "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", toEther(10)])))

        // swap 
        await marketplace.connect(admin).swapWithFiat(cid, bob.address , "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", toEther(10), proof)

        // validate the result
        expect(await erc1155.balanceOf( bob.address, 1)).to.equal(1)
    })

})