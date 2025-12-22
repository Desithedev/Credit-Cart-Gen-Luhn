// redeploy trigger - comment update
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { isValidBin, generateCard, generateTempMail, checkTempMail, checkIP, loadBinDatabase, lookupBinLocal, getBinInfo as lookupBin } from './utils.js';
import chkCommand from './commands/chk.js';
import massCommand from './commands/mass.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initializing local BIN database
const CSV_PATH = path.join(__dirname, '..', 'bin-list-data.csv');
loadBinDatabase(CSV_PATH);

// Configuración
// Use BOT_TOKEN from environment only. Do NOT hardcode tokens in source.
const BOT_TOKEN = process.env.BOT_TOKEN;
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

if (!BOT_TOKEN && !DRY_RUN) {
    console.error('Error: BOT_TOKEN must be set in environment variables (or enable DRY_RUN for local testing)');
    process.exit(1);
}

// If DRY_RUN is enabled we create a minimal bot-like object that logs calls
let bot;
if (DRY_RUN) {
    console.log('Starting in DRY_RUN mode: bot will not connect to Telegram API');
    // Minimal stub that supports used methods in this file
    bot = {
        use: () => { },
        command: () => { },
        hears: () => { },
        on: () => { },
        launch: async () => { console.log('DRY_RUN: bot.launch() called'); },
        stop: async () => { console.log('DRY_RUN: bot.stop() called'); },
        catch: () => { }
    };
} else {
    const { Telegraf } = await import('telegraf');
    bot = new Telegraf(BOT_TOKEN);
}

// Rate limiting and command debouncing
const userStates = new Map();
const COOLDOWN_PERIOD = 2000; // 2 seconds cooldown between commands
const processingCommands = new Set(); // Track commands being processed

const isCommandAllowed = (userId) => {
    const now = Date.now();
    const lastCommandTime = userStates.get(userId);

    if (!lastCommandTime || (now - lastCommandTime) >= COOLDOWN_PERIOD) {
        userStates.set(userId, now);
        return true;
    }
    return false;
};

// Middleware para rate limiting y prevención de duplicados
bot.use(async (ctx, next) => {
    if (ctx.message && ctx.message.text && ctx.message.text.startsWith('/')) {
        const userId = ctx.from.id;
        const messageId = ctx.message.message_id;
        const commandKey = `${userId}_${messageId}_slash`;

        // Si el comando ya está siendo procesado, ignorarlo
        if (processingCommands.has(commandKey)) {
            console.log(`Comando con / duplicado ignorado: ${commandKey}`);
            return;
        }

        // Si el usuario está en cooldown, ignorar el comando
        if (!isCommandAllowed(userId)) {
            console.log(`Comando con / ignorado por cooldown: ${commandKey}`);
            await ctx.reply('⚠️ Vui lòng đợi vài giây trước khi sử dụng lệnh khác.');
            return;
        }

        // Marcar el comando como en procesamiento
        processingCommands.add(commandKey);

        try {
            await next();
        } finally {
            // Limpiar después de un tiempo
            setTimeout(() => {
                processingCommands.delete(commandKey);
            }, 60000);
        }
    } else {
        await next();
    }
});

// Directorio de datos
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
}

// Funciones de utilidad
const getUserDataPath = (userId) => path.join(DATA_DIR, `${userId}.json`);

const loadUserData = (userId) => {
    const filePath = getUserDataPath(userId);
    if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    return {
        favorites: [],
        history: [],
        tempMail: null
    };
};

const saveUserData = (userId, data) => {
    const filePath = getUserDataPath(userId);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
};

// Función para consultar BIN usando Local DB y APIs alternativas
// MOVED TO UTILS.JS as getBinInfo
// const lookupBin = async (bin) => { ... }


// Función para registrar comandos con ambos prefijos
const registerCommand = (command, handler) => {
    // Registrar con prefijo /
    bot.command(command, handler);
    // Registrar con prefijo . usando regex insensible a mayúsculas
    bot.hears(new RegExp(`^\\.${command}\\b`, 'i'), handler);
};

// Función para extraer argumentos del mensaje
const getCommandArgs = (ctx) => {
    const text = ctx.message.text;
    // Si el comando empieza con /, usar split normal
    if (text.startsWith('/')) {
        return text.split(' ').slice(1).join(' ');
    }
    // Si el comando empieza con ., extraer todo después del comando
    const match = text.match(/^\.(\w+)\s*(.*)/);
    if (match) {
        return match[2];
    }
    return '';
};

// Función para generar mensaje de limpieza
const generateClearMessage = () => {
    return '⠀\n'.repeat(100) + '🧹 Đã xóa chat';
};

// Función robusta para parsear el input del comando gen
function parseGenInput(input) {
    // Quitar espacios al inicio y final
    input = input.trim();
    // Reemplazar múltiples separadores por uno solo
    input = input.replace(/\|/g, ' ').replace(/\s+/g, ' ');
    // Quitar caracteres x o X al final del bin
    let [bin, month, year, cvv] = input.split(' ');
    if (bin) bin = bin.replace(/x+$/i, '');
    // Si el mes y año vienen juntos (ej: 06/25 o 06/2025)
    if (month && /\//.test(month)) {
        const [m, y] = month.split('/');
        month = m;
        year = y && y.length === 2 ? '20' + y : y;
    }
    // Si el año es de 2 dígitos, convertir a 4
    if (year && year.length === 2) year = '20' + year;
    // Si el mes es inválido pero el año parece mes (ej: 2025 06)
    if (year && month && month.length === 4 && /^20[2-3][0-9]$/.test(month) && /^0[1-9]|1[0-2]$/.test(year)) {
        [month, year] = [year, month];
    }
    // Si el cvv contiene x, ignorar
    if (cvv && /x/i.test(cvv)) cvv = undefined;
    return { bin, month, year, cvv };
}

// Función para procesar comandos con punto
const handleDotCommand = async (ctx) => {
    const text = ctx.message.text;
    if (!text.startsWith('.')) return false;

    // Extraer el comando y los argumentos
    const match = text.match(/^\.(\w+)\s*(.*)/);
    if (!match) return false;

    const [, command, args] = match;
    console.log('Comando con punto detectado:', { command, args });

    switch (command.toLowerCase()) {
        case 'clear':
        case 'limpiar':
            await ctx.reply(generateClearMessage());
            return true;

        case 'gen':
            if (!args) {
                await ctx.reply('❌ Cách dùng: .gen BIN|MM|YYYY|CVV\nVí dụ: .gen 477349002646|05|2027|123');
                return true;
            }
            // Usar el nuevo parser
            const { bin, month: fixedMonth, year: fixedYear, cvv: fixedCVV } = parseGenInput(args);
            if (!isValidBin(bin)) {
                await ctx.reply('❌ BIN không hợp lệ. Chỉ được chứa số, từ 6 đến 16 chữ số.');
                return true;
            }
            if (fixedMonth && !/^(0[1-9]|1[0-2])$/.test(fixedMonth)) {
                await ctx.reply('❌ Tháng không hợp lệ. Phải từ 01 đến 12.');
                return true;
            }
            if (fixedYear && !/^([0-9]{2}|20[2-3][0-9])$/.test(fixedYear)) {
                await ctx.reply('❌ Năm không hợp lệ. Phải ở định dạng YY hoặc YYYY và lớn hơn năm hiện tại.');
                return true;
            }
            if (fixedCVV && !/^[0-9]{3,4}$/.test(fixedCVV)) {
                await ctx.reply('❌ CVV không hợp lệ. Phải chứa 3 hoặc 4 chữ số.');
                return true;
            }
            try {
                const cards = Array(10).fill().map(() => {
                    const card = generateCard(bin);
                    if (fixedMonth) card.month = fixedMonth;
                    if (fixedYear) card.year = fixedYear?.slice(-2) || card.year;
                    if (fixedCVV) card.cvv = fixedCVV;
                    return card;
                });
                const response = cards.map(card =>
                    `${card.number}|${card.month}|${card.year}|${card.cvv}`
                ).join('\n');
                // Guardar en historial
                const userId = ctx.from.id;
                const userData = loadUserData(userId);
                userData.history.unshift({
                    type: 'gen',
                    bin,
                    count: cards.length,
                    timestamp: new Date().toISOString()
                });
                saveUserData(userId, userData);
                await ctx.reply(`🎲 Thẻ đã tạo:\n\n${response}`);
            } catch (error) {
                console.error('Error en comando .gen:', error);
                await ctx.reply(`❌ Lỗi khi tạo thẻ: ${error.message}`);
            }
            return true;

        case 'bin':
            if (!args) {
                await ctx.reply('❌ Cách dùng: .bin BIN\nVí dụ: .bin 431940');
                return true;
            }
            if (!isValidBin(args)) {
                await ctx.reply('❌ BIN không hợp lệ. Chỉ được chứa số, từ 6 đến 16 chữ số.');
                return true;
            }
            try {
                const binInfo = await lookupBin(args);
                if (!binInfo) {
                    await ctx.reply('❌ Không tìm thấy thông tin cho BIN này');
                    return true;
                }

                const response = `
🔍 Thông tin BIN: ${args}

🏦 Ngân hàng: ${binInfo.bank}
💳 Thương hiệu: ${binInfo.brand}
🌍 Quốc gia: ${binInfo.country} (${binInfo.countryCode})
📱 Loại: ${binInfo.type}
⭐️ Hạng: ${binInfo.level}
                `;

                // Guardar en historial
                const userId = ctx.from.id;
                const userData = loadUserData(userId);
                userData.history.unshift({
                    type: 'lookup',
                    bin: args,
                    info: binInfo,
                    timestamp: new Date().toISOString()
                });
                saveUserData(userId, userData);

                await ctx.reply(response);
            } catch (error) {
                console.error('Error en comando .bin:', error);
                await ctx.reply(`❌ Error al consultar BIN: ${error.message}`);
            }
            return true;

        case 'start':
        case 'ayuda':
        case 'help':
            const helpText = `👋 Xin chào! Chào mừng đến với CARD GEN PRO

Tất cả lệnh hoạt động với / hoặc . (ví dụ: /gen hoặc .gen)

🔧 Tạo Thẻ
gen BIN|MM|YYYY|CVV  
► Tự động tạo 10 thẻ  
Ví dụ: gen 477349002646|05|2027|123

🔍 Tra cứu Thông minh
bin BIN  
► Thông tin chi tiết về BIN  
Ví dụ: bin 431940

ip <địa chỉ IP>  
► Tra cứu thông tin và rủi ro của IP  
Ví dụ: ip 8.8.8.8

cedula <số CCCD>  
► Tra cứu dữ liệu SRI qua CCCD  
Ví dụ: cedula 17xxxxxxxx

placa <biển số>
► Tra cứu dữ liệu xe qua biển số
Ví dụ: placa PDF9627

⭐️ Yêu thích
favoritos  
► Danh sách BIN đã lưu

agregarbin BIN [tháng] [năm] [cvv]  
► Lưu BIN để dùng sau

eliminarbin <chỉ số>  
► Xóa BIN khỏi danh sách

📋 Tiện ích
historial  
► Xem lại lịch sử tra cứu

clear  
► Xóa chat

ayuda  
► Hiển thị hướng dẫn này

🌐 Thử phiên bản web  
https://credit-cart-gen-luhn.vercel.app/index.html

Phát triển với ❤️ bởi @mat1520`;
            await ctx.reply(helpText);
            return true;

        case 'favoritos':
            const userDataFav = loadUserData(ctx.from.id);
            if (userDataFav.favorites.length === 0) {
                await ctx.reply('📌 Bạn chưa lưu BIN yêu thích nào');
                return true;
            }
            const responseFav = userDataFav.favorites.map((fav, index) =>
                `${index + 1}. ${fav.bin} (${fav.month || 'MM'}/${fav.year || 'YY'})`
            ).join('\n');
            await ctx.reply(`📌 BIN yêu thích của bạn:\n\n${responseFav}`);
            return true;

        case 'historial':
            const userDataHist = loadUserData(ctx.from.id);
            if (userDataHist.history.length === 0) {
                await ctx.reply('📝 Không có lịch sử tra cứu');
                return true;
            }
            const responseHist = userDataHist.history.slice(0, 10).map((item, index) => {
                const date = new Date(item.timestamp).toLocaleString();
                if (item.type === 'gen') {
                    return `${index + 1}. Tạo: ${item.bin} (${item.count} thẻ) - ${date}`;
                } else {
                    return `${index + 1}. Tra cứu: ${item.bin} - ${date}`;
                }
            }).join('\n');
            await ctx.reply(`📝 Lịch sử gần đây:\n\n${responseHist}`);
            return true;

        case 'agregarbin':
            if (!args) {
                await ctx.reply('❌ Cách dùng: .agregarbin BIN [tháng] [năm] [cvv]');
                return true;
            }
            // Usar el parser flexible
            const parsedAdd = parseGenInput(args);
            if (!isValidBin(parsedAdd.bin)) {
                await ctx.reply('❌ BIN không hợp lệ. Chỉ được chứa số, từ 6 đến 16 chữ số.');
                return true;
            }
            const userIdAdd = ctx.from.id;
            const userDataAdd = loadUserData(userIdAdd);
            if (userDataAdd.favorites.some(fav => fav.bin === parsedAdd.bin)) {
                await ctx.reply('❌ BIN này đã có trong danh sách yêu thích');
                return true;
            }
            userDataAdd.favorites.push({ bin: parsedAdd.bin, month: parsedAdd.month, year: parsedAdd.year, cvv: parsedAdd.cvv });
            saveUserData(userIdAdd, userDataAdd);
            await ctx.reply('✅ Đã thêm BIN vào yêu thích');
            return true;

        case 'eliminarbin':
            if (!args) {
                await ctx.reply('❌ Cách dùng: .eliminarbin <chỉ số> hoặc BIN');
                return true;
            }
            const userIdDel = ctx.from.id;
            const userDataDel = loadUserData(userIdDel);
            // Si es número, eliminar por índice
            if (/^\d+$/.test(args)) {
                const index = parseInt(args) - 1;
                if (isNaN(index) || index < 0 || index >= userDataDel.favorites.length) {
                    await ctx.reply('❌ Chỉ số không hợp lệ');
                    return true;
                }
                const removedBin = userDataDel.favorites.splice(index, 1)[0];
                saveUserData(userIdDel, userDataDel);
                await ctx.reply(`✅ Đã xóa BIN ${removedBin.bin} khỏi yêu thích`);
                return true;
            }
            // Si es BIN flexible, usar el parser
            const parsedDel = parseGenInput(args);
            const favIndex = userDataDel.favorites.findIndex(fav => fav.bin === parsedDel.bin);
            if (favIndex === -1) {
                await ctx.reply('❌ Không tìm thấy BIN này trong danh sách yêu thích');
                return true;
            }
            const removedBin = userDataDel.favorites.splice(favIndex, 1)[0];
            saveUserData(userIdDel, userDataDel);
            await ctx.reply(`✅ Đã xóa BIN ${removedBin.bin} khỏi yêu thích`);
            return true;

        case 'mail':
            await handleMailCommand(ctx);
            return true;

        case 'check':
            await handleCheckCommand(ctx);
            return true;

        case 'ip':
            await handleIPCommand(ctx);
            return true;
    }
    return false;
};

// Middleware para comandos con punto
bot.on('text', async (ctx, next) => {
    try {
        if (ctx.message.text.startsWith('.')) {
            const userId = ctx.from.id;
            const messageId = ctx.message.message_id;
            const commandKey = `${userId}_${messageId}_dot`;

            // Si el usuario está en cooldown, ignorar el comando
            if (!isCommandAllowed(userId)) {
                console.log(`Comando con . ignorado por cooldown: ${commandKey}`);
                await ctx.reply('⚠️ Vui lòng đợi vài giây trước khi sử dụng lệnh khác.');
                return;
            }

            console.log(`Procesando comando con punto: ${ctx.message.text}`);
            const handled = await handleDotCommand(ctx);
            if (!handled) {
                await next();
            }
        } else {
            await next();
        }
    } catch (error) {
        console.error('Error en middleware de texto:', error);
    }
});

// URL RAW de la imagen oficial OFFICIALT.png en GitHub
const HACKER_IMG_URL = 'https://raw.githubusercontent.com/mat1520/Credit-Cart-Gen-Luhn/main/telegram-bot/OFFICIALT.png';

const toolsBlock = `🛠 Công cụ khả dụng:

Tạo và Tra cứu:
• /gen BIN|MM|YYYY|CVV - Tạo thẻ 💳
• /bin BIN - Tra cứu BIN 🔍
• /ip <IP> - Tra cứu IP và rủi ro 🌐
• /cedula <số> - Tra cứu SRI qua CCCD 🪪
• /placa <số> - Tra cứu dữ liệu xe 🚗

Email Tạm thời:
• /mail - Tạo email tạm thời 📧
• /check - Kiểm tra tin nhắn email 📨

Yêu thích:
• /favoritos - BIN yêu thích của bạn ⭐️
• /agregarbin BIN tháng năm cvv - Thêm BIN vào yêu thích ➕
• /eliminarbin <chỉ số> - Xóa BIN khỏi yêu thích 🗑

Kiểm tra:
• /chk cc|mm|yy|cvv - Kiểm tra thẻ (Recurly) 💳
• /mass list - Kiểm tra hàng loạt (Paypal) 💳

Tiện ích:
• /historial - Lịch sử của bạn 📝
• /clear - Xóa chat 🧹

Tất cả lệnh hoạt động với / hoặc .`;

// Comandos del bot
registerCommand('start', async (ctx) => {
    const warning = '⚡️ <b>CẢNH BÁO!</b> Đây không phải là diễn tập';
    const desc = '<i>Bot này chỉ dành cho mục đích giáo dục và thử nghiệm an ninh mạng. Chào mừng đến với phòng thí nghiệm ảo về thẻ và OSINT. Chỉ dành cho hacker mũ trắng, pentester và những người tò mò. Việc sử dụng sai thông tin được tạo ra có thể dẫn đến hậu quả pháp lý. Hãy khám phá và tự chịu rủi ro! 👾</i>';
    const welcome = '<b>CardGen Pro BOT</b>\n';
    await ctx.replyWithPhoto(HACKER_IMG_URL, {
        caption: `${warning}\n\n${welcome}\n${desc}`,
        parse_mode: 'HTML'
    });
    await ctx.reply(toolsBlock);
    await ctx.reply('Chọn một tùy chọn từ menu:', {
        reply_markup: {
            keyboard: [
                ['🛠 Tools', '👤 Creator'],
                ['💸 Donate', '🐙 GitHub']
            ],
            resize_keyboard: true,
            one_time_keyboard: true
        }
    });
});

// Handlers para los botones del menú principal
bot.hears('🛠 Tools', (ctx) => {
    ctx.reply(toolsBlock);
});
bot.hears('👤 Creator', (ctx) => {
    ctx.reply('👤 Người tạo: @MAT3810\nhttps://t.me/MAT3810');
});
bot.hears('💸 Donate', (ctx) => {
    ctx.reply('💸 Bạn có thể ủng hộ dự án tại đây:\nhttps://paypal.me/ArielMelo200?country.x=EC&locale.x=es_XC');
});
bot.hears('🐙 GitHub', (ctx) => {
    ctx.reply('🐙 GitHub: https://github.com/mat1520');
});

registerCommand('help', (ctx) => {
    ctx.reply(toolsBlock);
});

registerCommand('ayuda', (ctx) => {
    ctx.reply(toolsBlock);
});

registerCommand('gen', async (ctx) => {
    const messageId = ctx.message.message_id;
    console.log(`Procesando comando gen, messageId: ${messageId}`);
    try {
        const input = getCommandArgs(ctx);
        console.log('Input completo:', ctx.message.text);
        console.log('Input procesado:', input);
        if (!input) {
            return ctx.reply('❌ Cách dùng: /gen hoặc .gen BIN|MM|YYYY|CVV\nVí dụ: /gen 477349002646|05|2027|123');
        }
        // Usar el nuevo parser
        const { bin, month: fixedMonth, year: fixedYear, cvv: fixedCVV } = parseGenInput(input);
        console.log('Parseado:', { bin, fixedMonth, fixedYear, fixedCVV });
        if (!isValidBin(bin)) {
            return ctx.reply('❌ BIN không hợp lệ. Chỉ được chứa số, từ 6 đến 16 chữ số.');
        }
        if (fixedMonth && !/^(0[1-9]|1[0-2])$/.test(fixedMonth)) {
            return ctx.reply('❌ Tháng không hợp lệ. Phải từ 01 đến 12.');
        }
        if (fixedYear && !/^([0-9]{2}|20[2-3][0-9])$/.test(fixedYear)) {
            return ctx.reply('❌ Năm không hợp lệ. Phải ở định dạng YY hoặc YYYY và lớn hơn năm hiện tại.');
        }
        if (fixedCVV && !/^[0-9]{3,4}$/.test(fixedCVV)) {
            return ctx.reply('❌ CVV không hợp lệ. Phải chứa 3 hoặc 4 chữ số.');
        }
        const cards = Array(10).fill().map(() => {
            const card = generateCard(bin);
            if (fixedMonth) card.month = fixedMonth;
            if (fixedYear) card.year = fixedYear?.slice(-2) || card.year;
            if (fixedCVV) card.cvv = fixedCVV;
            return card;
        });
        let binInfo = {};
        try {
            console.log('Fetching BIN info...');
            binInfo = await lookupBin(bin.slice(0, 6));
            console.log('Got BIN info:', binInfo);
        } catch (e) { console.error('BIN lookup error:', e); }

        if (!binInfo) binInfo = {};
        const bank = binInfo.bank || 'Không có';
        const brand = binInfo.brand || 'Không có';
        const country = binInfo.country || 'Không có';
        const countryCode = binInfo.countryCode || '';
        const type = binInfo.type || 'Không có';
        const level = binInfo.level || 'Không có';
        const flag = countryCode ? String.fromCodePoint(...[...countryCode.toUpperCase()].map(c => 127397 + c.charCodeAt(0))) : '';
        const userName = ctx.from.first_name || 'Usuario';
        const header = `\n𝘽𝙞𝙣 -» ${bin}xxxx|${fixedMonth || 'xx'}|${fixedYear ? fixedYear.slice(-2) : 'xx'}|${fixedCVV || 'rnd'}\n─━─━─━─━─━─━─━─━─━─━─━─━─`;
        const tarjetas = cards.map(card => `${card.number}|${card.month}|${card.year}|${card.cvv}`).join('\n');
        const cardBlock = tarjetas;
        const binInfoFormatted = `\n─━─━─━─━─━─━─━─━─━─━─━─━─\n• 𝙄𝙣𝙛𝙤 -» ${brand} - ${type} - ${level}\n• 𝙉𝙜𝙖𝙣 𝙝𝙖𝙣𝙜 -» ${bank}\n• 𝙌𝙪𝙤𝙘 𝙜𝙞𝙖 -» ${country} ${flag}\n─━─━─━─━─━─━─━─━─━─━─━─━─\n• 𝙏𝙖𝙤 𝙗𝙤𝙞 -» ${userName} -» @CardGen_Pro_BOT`;
        const response = `${header}\n${cardBlock}\n${binInfoFormatted}`;
        const userId = ctx.from.id;
        const userData = loadUserData(userId);
        userData.history.unshift({
            type: 'gen',
            bin,
            count: cards.length,
            timestamp: new Date().toISOString()
        });
        saveUserData(userId, userData);
        console.log('Sending response to user...');
        await ctx.reply(response).catch(err => console.error('FAILED TO REPLY:', err));
        console.log('Response sent.');
    } catch (error) {
        console.error(`Error en comando gen, messageId: ${messageId}:`, error);
        await ctx.reply(`❌ Lỗi khi tạo thẻ: ${error.message}`);
    }
});

registerCommand('bin', async (ctx) => {
    try {
        const bin = getCommandArgs(ctx);
        console.log('Input completo:', ctx.message.text);
        console.log('BIN procesado:', bin);

        if (!bin) {
            return ctx.reply('❌ Cách dùng: /bin hoặc .bin BIN\nVí dụ: /bin 431940');
        }

        if (!isValidBin(bin)) {
            return ctx.reply('❌ BIN không hợp lệ. Chỉ được chứa số, từ 6 đến 16 chữ số.');
        }

        const binInfo = await lookupBin(bin);
        if (!binInfo) {
            return ctx.reply('❌ Không tìm thấy thông tin cho BIN này');
        }

        const response = `
🔍 Thông tin BIN: ${bin}

🏦 Ngân hàng: ${binInfo.bank}
💳 Thương hiệu: ${binInfo.brand}
🌍 Quốc gia: ${binInfo.country} (${binInfo.countryCode})
📱 Loại: ${binInfo.type}
⭐️ Hạng: ${binInfo.level}
        `;

        // Guardar en historial
        const userId = ctx.from.id;
        const userData = loadUserData(userId);
        userData.history.unshift({
            type: 'lookup',
            bin,
            info: binInfo,
            timestamp: new Date().toISOString()
        });
        saveUserData(userId, userData);

        await ctx.reply(response);
    } catch (error) {
        console.error('Error en comando bin:', error);
        await ctx.reply(`❌ Error al consultar BIN: ${error.message}`);
    }
});

registerCommand('favoritos', (ctx) => {
    const userId = ctx.from.id;
    const userData = loadUserData(userId);

    if (userData.favorites.length === 0) {
        return ctx.reply('📌 Bạn chưa lưu BIN yêu thích nào');
    }

    const response = userData.favorites.map((fav, index) =>
        `${index + 1}. ${fav.bin} (${fav.month || 'MM'}/${fav.year || 'YY'})`
    ).join('\n');

    ctx.reply(`📌 BIN yêu thích của bạn:\n\n${response}`);
});

registerCommand('historial', (ctx) => {
    const userId = ctx.from.id;
    const userData = loadUserData(userId);

    if (userData.history.length === 0) {
        return ctx.reply('📝 No hay historial de consultas');
    }

    const response = userData.history.slice(0, 10).map((item, index) => {
        const date = new Date(item.timestamp).toLocaleString();
        if (item.type === 'gen') {
            return `${index + 1}. Generación: ${item.bin} (${item.count} tarjetas) - ${date}`;
        } else {
            return `${index + 1}. Consulta: ${item.bin} - ${date}`;
        }
    }).join('\n');

    ctx.reply(`📝 Lịch sử gần đây:\n\n${response}`);
});

registerCommand('clear', async (ctx) => {
    await ctx.reply(generateClearMessage());
});

registerCommand('limpiar', async (ctx) => {
    await ctx.reply(generateClearMessage());
});

registerCommand('ping', async (ctx) => {
    await ctx.reply('🏓 Pong! Bot is active.');
});

console.log('Registering chk and mass commands...');
registerCommand('chk', async (ctx) => {
    console.log('Command /chk triggered');
    await chkCommand(ctx);
});
registerCommand('mass', async (ctx) => {
    console.log('Command /mass triggered');
    await massCommand(ctx);
});

registerCommand('cedula', async (ctx) => {
    const cedula = getCommandArgs(ctx).trim();
    if (!cedula || !/^[0-9]{10}$/.test(cedula)) {
        return ctx.reply('❌ Cách dùng: /cedula <số CCCD>\nVí dụ: /cedula 17xxxxxxxx');
    }
    try {
        // Mejor manejo: timeout, retries, y mensajes según status
        const buildUrl = () => `https://srienlinea.sri.gob.ec/movil-servicios/api/v1.0/deudas/porIdentificacion/${cedula}/?tipoPersona=N&_=${Date.now()}`;

        const fetchWithTimeout = async (resource, options = {}) => {
            const { timeout = 8000 } = options;
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), timeout);
            try {
                const resp = await fetch(resource, { ...options, signal: controller.signal });
                clearTimeout(id);
                return resp;
            } catch (err) {
                clearTimeout(id);
                throw err;
            }
        };

        // Intentar hasta 2 veces en caso de fallo transitorio
        let resp; let data;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                resp = await fetchWithTimeout(buildUrl(), { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
                // Si recibimos 429 o 5xx, retry una vez más con backoff
                if (resp.status === 429) {
                    if (attempt === 1) await new Promise(r => setTimeout(r, 1200));
                    else break;
                }
                if (resp.status >= 500 && resp.status < 600) {
                    if (attempt === 1) await new Promise(r => setTimeout(r, 800));
                    else break;
                }
                break;
            } catch (err) {
                if (attempt === 2) throw err;
                await new Promise(r => setTimeout(r, 700));
            }
        }

        if (!resp) throw new Error('No response from SRI');

        // Manejar códigos HTTP comunes
        if (resp.status === 404) {
            return ctx.reply(`❌ Không tìm thấy thông tin cho số CCCD ${cedula}.`);
        }
        if (resp.status === 429) {
            return ctx.reply('⚠️ Dịch vụ tạm thời quá tải. Vui lòng thử lại sau vài giây.');
        }
        if (resp.status >= 400) {
            console.error('SRI responded with status', resp.status);
            return ctx.reply('❌ Lỗi khi tra cứu CCCD. Vui lòng thử lại sau.');
        }

        // Parsear JSON de forma segura
        try {
            data = await resp.json();
        } catch (err) {
            console.error('Error parsing SRI response JSON:', err);
            return ctx.reply('❌ Respuesta inesperada del servicio SRI. Intenta más tarde.');
        }

        if (data && data.contribuyente) {
            const info = data.contribuyente;
            let msg = `🪪 Thông tin SRI cho CCCD: <code>${cedula}</code>\n\n`;
            msg += `• <b>Tên thương mại:</b> ${info.nombreComercial || info.denominacion || 'Không có'}\n`;
            msg += `• <b>Loại:</b> ${info.clase || 'Không có'}\n`;
            msg += `• <b>Loại giấy tờ:</b> ${info.tipoIdentificacion || 'Không có'}\n`;
            if (info.fechaInformacion) {
                try {
                    const date = new Date(Number(info.fechaInformacion));
                    if (!isNaN(date)) msg += `• <b>Ngày cập nhật:</b> ${date.toLocaleString()}\n`;
                } catch (e) { /* ignore */ }
            }
            if (data.deuda) {
                msg += `\n💸 <b>Deuda:</b> ${data.deuda.estado || 'No disponible'} - ${data.deuda.monto || 'No disponible'}`;
            } else {
                msg += `\n💸 <b>Deuda:</b> Sin registro de deuda`;
            }
            await ctx.replyWithHTML(msg);
        } else {
            await ctx.reply('❌ Không tìm thấy thông tin cho danh tính được cung cấp.');
        }
    } catch (error) {
        console.error('Error en comando /cedula:', error);
        // Mensaje más informativo para el usuario final
        if (error.name === 'AbortError') {
            await ctx.reply('⚠️ Tiempo de espera agotado al contactar al servicio SRI. Intenta de nuevo.');
        } else {
            await ctx.reply('❌ Error al consultar la cédula. Intenta más tarde.');
        }
    }
});

// Función para consultar datos de placa vehicular
async function consultarPlaca(placa) {
    const url = `https://srienlinea.sri.gob.ec/movil-servicios/api/v1.0/matriculacion/valor/${placa}`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('Error en la consulta');
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error al consultar la placa:', error);
        throw error;
    }
}

// Función para manejar comandos de Telegram
function handleTelegramCommand(command, placa) {
    if (command === '.placa' || command === '/placa') {
        consultarPlaca(placa)
            .then(data => {
                // Aquí puedes enviar la respuesta al usuario de Telegram
                console.log('Datos de la placa:', data);
                // Ejemplo: bot.sendMessage(chatId, JSON.stringify(data, null, 2));
            })
            .catch(error => {
                console.error('Error al consultar la placa:', error);
                // Ejemplo: bot.sendMessage(chatId, 'Error al consultar la placa.');
            });
    } else if (command === '/start') {
        // Mensaje de bienvenida
        console.log('Bienvenido al bot de consulta de placas. Usa .placa o /placa seguido de la placa para consultar.');
        // Ejemplo: bot.sendMessage(chatId, 'Bienvenido al bot de consulta de placas. Usa .placa o /placa seguido de la placa para consultar.');
    } else if (command === '/help') {
        // Mensaje de ayuda
        console.log('Comandos disponibles:\n.placa [número de placa] - Consulta datos de la placa\n/placa [número de placa] - Consulta datos de la placa\n/start - Inicia el bot\n/help - Muestra este mensaje de ayuda');
        // Ejemplo: bot.sendMessage(chatId, 'Comandos disponibles:\n.placa [número de placa] - Consulta datos de la placa\n/placa [número de placa] - Consulta datos de la placa\n/start - Inicia el bot\n/help - Muestra este mensaje de ayuda');
    }
}

// Ejemplo de uso
// handleTelegramCommand('.placa', 'PDF9627');

// Registrar comando placa
registerCommand('placa', async (ctx) => {
    const placa = getCommandArgs(ctx).toUpperCase(); // Convertir a mayúsculas
    if (!placa) {
        await ctx.reply('❌ Cách dùng: .placa BIEN_SO\nVí dụ: .placa PDF9627');
        return;
    }

    try {
        const data = await consultarPlaca(placa);
        const mensaje = `
🚗 Thông tin xe: ${placa}

📝 Hãng: ${data.marca}
🚙 Mẫu: ${data.modelo}
📅 Năm: ${data.anioModelo}
🔧 Dung tích: ${data.cilindraje}
🏭 Xuất xứ: ${data.paisFabricacion}
🚦 Loại: ${data.clase}
🔑 Dịch vụ: ${data.servicio}
💰 Tổng thanh toán: $${data.total}

📍 Nơi đăng ký: ${data.cantonMatricula}
📆 Đăng ký lần cuối: ${new Date(data.fechaUltimaMatricula).toLocaleDateString()}
⏳ Hết hạn: ${new Date(data.fechaCaducidadMatricula).toLocaleDateString()}
🔄 Trạng thái: ${data.estadoAuto}
`;
        await ctx.reply(mensaje);
    } catch (error) {
        console.error('Error al consultar la placa:', error);
        await ctx.reply('❌ Lỗi khi tra cứu biển số. Vui lòng kiểm tra lại biển số.');
    }
});

// Función para manejar el comando de correo temporal
const handleMailCommand = async (ctx) => {
    try {
        const userId = ctx.from.id;
        const userData = loadUserData(userId);

        // Enviar mensaje de espera
        const waitMsg = await ctx.reply('⏳ Đang tạo email ảo...');

        try {
            // Generar nuevo correo temporal
            const { email, token, password } = await generateTempMail();

            // Guardar el token y la contraseña en los datos del usuario
            userData.tempMail = { email, token, password };
            saveUserData(userId, userData);

            // Actualizar mensaje de espera con el correo generado
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                null,
                `📧 *Email Ảo Đã Tạo*\n\n` +
                `📨 *Email:* \`${email}\`\n` +
                `🔑 *Mật khẩu:* \`${password}\`\n\n` +
                `⚠️ Email này là tạm thời và sẽ tự động bị xóa.\n` +
                `📝 Dùng \`.check\` để kiểm tra tin nhắn mới.`,
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error('Error en comando mail:', error);
            // Actualizar mensaje de espera con el error
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                null,
                `❌ Lỗi khi tạo email ảo: ${error.message}\nVui lòng thử lại.`
            );
        }
    } catch (error) {
        console.error('Error general en comando mail:', error);
        await ctx.reply('❌ Lỗi khi tạo email ảo. Vui lòng thử lại.');
    }
};

// Función para verificar mensajes
const handleCheckCommand = async (ctx) => {
    try {
        const userId = ctx.from.id;
        const userData = loadUserData(userId);

        if (!userData.tempMail) {
            await ctx.reply('❌ Bạn không có email ảo nào đang hoạt động. Dùng \`.mail\` để tạo.');
            return;
        }

        // Enviar mensaje de espera
        const waitMsg = await ctx.reply('⏳ Đang kiểm tra tin nhắn...');

        try {
            const messages = await checkTempMail(userData.tempMail.token);

            if (!messages || messages.length === 0) {
                await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    waitMsg.message_id,
                    null,
                    `📭 Không có tin nhắn mới trong email: ${userData.tempMail.email}`
                );
                return;
            }

            // Actualizar mensaje de espera
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                null,
                `📨 Tìm thấy ${messages.length} tin nhắn trong ${userData.tempMail.email}`
            );

            // Mostrar los mensajes
            for (const msg of messages) {
                try {
                    let messageText = `📨 *Tin nhắn mới*\n\n`;
                    messageText += `*Từ:* ${msg.from?.address || 'Không xác định'}\n`;
                    messageText += `*Đến:* ${msg.to?.[0]?.address || userData.tempMail.email}\n`;
                    messageText += `*Chủ đề:* ${msg.subject || 'Không có chủ đề'}\n`;
                    messageText += `*Ngày:* ${new Date(msg.createdAt).toLocaleString()}\n\n`;

                    let content = msg.text || msg.html || 'Không có nội dung';
                    if (msg.html) {
                        content = content
                            .replace(/<[^>]*>/g, '')
                            .replace(/&nbsp;/g, ' ')
                            .replace(/&amp;/g, '&')
                            .replace(/&lt;/g, '<')
                            .replace(/&gt;/g, '>')
                            .replace(/&quot;/g, '"')
                            .replace(/&#39;/g, "'");
                    }

                    if (content.length > 1000) {
                        content = content.substring(0, 1000) + '...\n(nội dung bị cắt)';
                    }

                    messageText += `*Nội dung:*\n${content}\n`;

                    await ctx.reply(messageText, {
                        parse_mode: 'Markdown',
                        disable_web_page_preview: true
                    });
                } catch (msgError) {
                    console.error('Error al procesar mensaje individual:', msgError);
                    await ctx.reply('❌ Error al procesar un mensaje. Continuando con los demás...');
                }
            }
        } catch (error) {
            console.error('Error al verificar mensajes:', error);

            if (error.message === 'Token inválido o expirado') {
                try {
                    // Intentar renovar el token
                    const tokenResponse = await fetch('https://api.mail.tm/token', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            address: userData.tempMail.email,
                            password: userData.tempMail.password
                        })
                    });

                    if (!tokenResponse.ok) {
                        throw new Error('No se pudo renovar el token');
                    }

                    const tokenData = await tokenResponse.json();
                    userData.tempMail.token = tokenData.token;
                    saveUserData(userId, userData);

                    // Intentar verificar mensajes nuevamente
                    const messages = await checkTempMail(tokenData.token);

                    if (!messages || messages.length === 0) {
                        await ctx.telegram.editMessageText(
                            ctx.chat.id,
                            waitMsg.message_id,
                            null,
                            `📭 No hay mensajes nuevos en el correo: ${userData.tempMail.email}`
                        );
                        return;
                    }

                    // Mostrar los mensajes
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        waitMsg.message_id,
                        null,
                        `📨 Tìm thấy ${messages.length} tin nhắn tại ${userData.tempMail.email}`
                    );

                    for (const msg of messages) {
                        try {
                            let messageText = `📨 *Tin nhắn mới*\n\n`;
                            messageText += `*Từ:* ${msg.from?.address || 'Không xác định'}\n`;
                            messageText += `*Đến:* ${msg.to?.[0]?.address || userData.tempMail.email}\n`;
                            messageText += `*Chủ đề:* ${msg.subject || 'Không có chủ đề'}\n`;
                            messageText += `*Ngày:* ${new Date(msg.createdAt).toLocaleString()}\n\n`;

                            let content = msg.text || msg.html || 'Không có nội dung';
                            if (msg.html) {
                                content = content
                                    .replace(/<[^>]*>/g, '')
                                    .replace(/&nbsp;/g, ' ')
                                    .replace(/&amp;/g, '&')
                                    .replace(/&lt;/g, '<')
                                    .replace(/&gt;/g, '>')
                                    .replace(/&quot;/g, '"')
                                    .replace(/&#39;/g, "'");
                            }

                            if (content.length > 1000) {
                                content = content.substring(0, 1000) + '...\n(nội dung bị cắt)';
                            }

                            messageText += `*Nội dung:*\n${content}\n`;

                            await ctx.reply(messageText, {
                                parse_mode: 'Markdown',
                                disable_web_page_preview: true
                            });
                        } catch (msgError) {
                            console.error('Error al procesar mensaje individual:', msgError);
                            await ctx.reply('❌ Lỗi khi xử lý tin nhắn. Đang tiếp tục...');
                        }
                    }
                } catch (renewError) {
                    console.error('Error al renovar token:', renewError);
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        waitMsg.message_id,
                        null,
                        '❌ Phiên email của bạn đã hết hạn. Vui lòng tạo email mới bằng \`.mail\`'
                    );
                }
            } else {
                await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    waitMsg.message_id,
                    null,
                    `❌ Lỗi khi kiểm tra tin nhắn: ${error.message}\nVui lòng thử lại.`
                );
            }
        }
    } catch (error) {
        console.error('Error general en comando check:', error);
        await ctx.reply('❌ Lỗi khi kiểm tra tin nhắn. Vui lòng thử lại.');
    }
};

// Registrar comandos
registerCommand('mail', handleMailCommand);
registerCommand('check', handleCheckCommand);

// Función para manejar el comando de verificación de IP
const handleIPCommand = async (ctx) => {
    try {
        const ip = getCommandArgs(ctx);
        if (!ip) {
            await ctx.reply('❌ Cách dùng: /ip hoặc .ip <địa chỉ IP>\nVí dụ: /ip 8.8.8.8');
            return;
        }

        // Validar formato de IP
        const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
        const ipv6Regex = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
        if (!ipv4Regex.test(ip) && !ipv6Regex.test(ip)) {
            await ctx.reply('❌ Định dạng IP không hợp lệ. Phải là địa chỉ IPv4 hoặc IPv6 hợp lệ.');
            return;
        }

        // Enviar mensaje de espera
        const waitMsg = await ctx.reply('⏳ Đang kiểm tra IP...');

        try {
            const ipInfo = await checkIP(ip);

            // Crear mensaje con la información
            let message = `🔍 *Thông tin IP: ${ip}*\n\n`;
            message += `*Thông tin Cơ bản:*\n`;
            message += `• Quốc gia: ${ipInfo.country}\n`;
            message += `• Thành phố: ${ipInfo.city}\n`;
            message += `• ISP: ${ipInfo.isp}\n\n`;
            message += `*Kiểm tra Bảo mật:*\n`;
            message += `• Proxy/VPN: ${ipInfo.proxy ? '✅ Có' : '❌ Không'}\n`;
            message += `• Tor: ${ipInfo.tor ? '✅ Có' : '❌ Không'}\n`;
            message += `• Hosting: ${ipInfo.hosting ? '✅ Có' : '❌ Không'}\n`;
            message += `• Mức độ Rủi ro: ${ipInfo.riskLevel}\n\n`;
            message += `*Thông tin Bổ sung:*\n`;
            message += `• ASN: ${ipInfo.asn}\n`;
            message += `• Tổ chức: ${ipInfo.organization}\n`;
            message += `• Múi giờ: ${ipInfo.timezone}`;

            // Guardar en historial
            const userId = ctx.from.id;
            const userData = loadUserData(userId);
            userData.history.unshift({
                type: 'ip_check',
                ip: ip,
                info: ipInfo,
                timestamp: new Date().toISOString()
            });
            saveUserData(userId, userData);

            // Actualizar mensaje de espera con los resultados
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                null,
                message,
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error('Error al verificar IP:', error);
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                null,
                `❌ Lỗi khi kiểm tra IP: ${error.message}`
            );
        }
    } catch (error) {
        console.error('Error general en comando IP:', error);
        await ctx.reply('❌ Lỗi khi xử lý lệnh. Vui lòng thử lại.');
    }
};

// Registrar comando IP
registerCommand('ip', handleIPCommand);

// Actualizar el mensaje de ayuda
const helpMessage = `🤖 *CardGen Pro Bot*\n\n` +
    `*Lệnh khả dụng:*\n` +
    `• \`/start\` hoặc \`.start\` - Hiển thị trợ giúp và lệnh\n` +
    `• \`/gen\` hoặc \`.gen\` - Tạo thẻ\n` +
    `• \`/bin\` hoặc \`.bin\` - Tra cứu thông tin BIN\n` +
    `• \`/cedula\` hoặc \`.cedula\` - Tra cứu thông tin CCCD\n` +
    `• \`/placa\` hoặc \`.placa\` - Tra cứu thông tin Xe\n` +
    `• \`/mail\` hoặc \`.mail\` - Tạo email ảo\n` +
    `• \`/check\` hoặc \`.check\` - Kiểm tra tin nhắn\n` +
    `• \`/ip\` hoặc \`.ip\` - Kiểm tra IP và rủi ro\n` +
    `• \`/favoritos\` hoặc \`.favoritos\` - Xem BIN yêu thích\n` +
    `• \`/agregarbin\` hoặc \`.agregarbin\` - Lưu BIN vào yêu thích\n` +
    `• \`/eliminarbin\` hoặc \`.eliminarbin\` - Xóa BIN khỏi yêu thích\n` +
    `• \`/historial\` hoặc \`.historial\` - Xem lịch sử tra cứu\n` +
    `• \`/clear\` hoặc \`.clear\` - Xóa chat\n` +
    `• \`/limpiar\` hoặc \`.limpiar\` - Xóa chat\n` +
    `• \`/ayuda\` hoặc \`.ayuda\` - Hiển thị trợ giúp\n\n` +
    `*Ví dụ:*\n` +
    `• \`.gen 477349002646|05|2027|123\`\n` +
    `• \`.bin 477349\`\n` +
    `• \`.cedula 17xxxxxxxx\`\n` +
    `• \`.placa PDF9627\`\n` +
    `• \`.mail\`\n` +
    `• \`.check\`\n` +
    `• \`.ip 8.8.8.8\``;

// Iniciar el bot
let isShuttingDown = false;

const startBot = async () => {
    try {
        await bot.launch();
        console.log('Bot iniciado');

        // Signal ready to PM2
        if (process.send) {
            process.send('ready');
        }
    } catch (err) {
        console.error('Error al iniciar el bot:', err);
        process.exit(1);
    }
};

// Error handling for the bot
bot.catch((err, ctx) => {
    console.error('Error en el manejo del comando:', err);
    if (ctx && !isShuttingDown) {
        ctx.reply('❌ Đã xảy ra lỗi khi xử lý lệnh. Vui lòng thử lại.');
    }
});

// Graceful shutdown
const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`Recibida señal ${signal}. Iniciando apagado gracioso...`);

    try {
        await bot.stop(signal);
        console.log('Bot detenido correctamente');
    } catch (err) {
        console.error('Error al detener el bot:', err);
    }

    process.exit(0);
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// Start the bot
startBot();