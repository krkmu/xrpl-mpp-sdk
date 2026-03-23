#!/usr/bin/env bash
# Two-terminal demo: PayChannel lifecycle
#
# This demo opens a channel, makes 5 off-chain micropayments,
# then closes the channel. Prints explorer links for create + close txs.
#
# Usage:
#   npx tsx demo/channel-demo.ts --sender-seed <SEED> --receiver-seed <SEED>
#
# Or run manually:
# 1. Open channel:    openChannel({ seed, destination, amount, settleDelay })
# 2. Sign claims:     5x signPaymentChannelClaim
# 3. Close channel:   close({ seed, channelId, amount, signature })

set -euo pipefail

echo "=== PayChannel Demo ==="
echo ""
echo "This demo requires funded testnet wallets."
echo ""
echo "1. Get testnet wallets at: https://faucet.altnet.rippletest.net/accounts"
echo ""
echo "2. Run the channel demo script:"
echo "   npx tsx demo/channel-demo.ts --sender-seed <SENDER_SEED> --receiver-seed <RECEIVER_SEED>"
echo ""
echo "The script will:"
echo "  - Open a PayChannel (on-chain)"
echo "  - Make 5 off-chain micropayments (signed claims)"
echo "  - Close the channel (on-chain)"
echo "  - Print explorer links for create + close transactions"
echo ""
echo "Explorer: https://testnet.xrpl.org/transactions/<TX_HASH>"
