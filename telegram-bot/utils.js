// Función para validar BIN
export const isValidBin = (bin) => {
    if (!bin) return false;
    if (!/^\d{6,16}$/.test(bin)) return false;
    return true;
};

// Función para generar número aleatorio
const randomNum = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Función para generar mes aleatorio
const generateMonth = () => {
    const month = randomNum(1, 12);
    return month.toString().padStart(2, '0');
};

// Función para generar año aleatorio
const generateYear = () => {
    const currentYear = new Date().getFullYear();
    const year = randomNum(currentYear + 1, currentYear + 10);
    return year.toString().slice(-2);
};

// Función para generar CVV aleatorio
const generateCVV = () => {
    return randomNum(100, 999).toString();
};

// Algoritmo de Luhn
const luhnCheck = (num) => {
    let arr = (num + '')
        .split('')
        .reverse()
        .map(x => parseInt(x));
    let sum = arr.reduce((acc, val, i) => {
        if (i % 2 !== 0) {
            const doubled = val * 2;
            return acc + (doubled > 9 ? doubled - 9 : doubled);
        }
        return acc + val;
    }, 0);
    return sum % 10 === 0;
};

// Función para generar número de tarjeta válido
const generateValidCardNumber = (bin) => {
    const length = 16;
    let cardNumber = bin;

    // Completar con números aleatorios hasta length-1
    while (cardNumber.length < length - 1) {
        cardNumber = cardNumber + randomNum(0, 9);
    }

    // Encontrar el último dígito que hace válido el número
    for (let i = 0; i <= 9; i++) {
        const fullNumber = cardNumber + i;
        if (luhnCheck(fullNumber)) {
            return fullNumber;
        }
    }

    return cardNumber + '0'; // Fallback
};

// Función principal para generar tarjeta
export const generateCard = (bin) => {
    return {
        number: generateValidCardNumber(bin),
        month: generateMonth(),
        year: generateYear(),
        cvv: generateCVV()
    };
};

// Función para generar correo temporal
export const generateTempMail = async () => {
    try {
        console.log('Iniciando generación de correo temporal...');

        // Obtener dominios disponibles
        const domainsResponse = await fetch('https://api.mail.tm/domains');
        if (!domainsResponse.ok) {
            throw new Error('Error al obtener dominios');
        }

        const domainsData = await domainsResponse.json();
        if (!domainsData['hydra:member'] || domainsData['hydra:member'].length === 0) {
            throw new Error('No hay dominios disponibles');
        }

        const domain = domainsData['hydra:member'][0].domain;
        console.log('Dominio seleccionado:', domain);

        // Generar nombre de usuario aleatorio
        const username = Math.random().toString(36).substring(2, 10);
        const email = `${username}@${domain}`;
        const password = Math.random().toString(36).substring(2, 15);

        console.log('Creando cuenta con:', { email, password });

        // Crear cuenta
        const accountResponse = await fetch('https://api.mail.tm/accounts', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                address: email,
                password: password
            })
        });

        if (!accountResponse.ok) {
            const errorData = await accountResponse.json();
            console.error('Error al crear cuenta:', errorData);
            throw new Error('Error al crear cuenta de correo');
        }

        console.log('Cuenta creada, obteniendo token...');

        // Obtener token
        const tokenResponse = await fetch('https://api.mail.tm/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                address: email,
                password: password
            })
        });

        if (!tokenResponse.ok) {
            const errorData = await tokenResponse.json();
            console.error('Error al obtener token:', errorData);
            throw new Error('Error al obtener token');
        }

        const tokenData = await tokenResponse.json();
        console.log('Token obtenido correctamente');

        return {
            email,
            token: tokenData.token,
            password
        };
    } catch (error) {
        console.error('Error al generar correo temporal:', error);
        throw error;
    }
};

// Función para verificar mensajes en el correo temporal
export const checkTempMail = async (token) => {
    try {
        console.log('Iniciando verificación de mensajes...');

        // Validar que el token no esté vacío
        if (!token) {
            throw new Error('Token no válido');
        }

        // Primero verificamos que el token sea válido
        const meResponse = await fetch('https://api.mail.tm/me', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!meResponse.ok) {
            throw new Error('Token inválido o expirado');
        }

        // Obtenemos los mensajes
        const messagesResponse = await fetch('https://api.mail.tm/messages?page=1', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!messagesResponse.ok) {
            throw new Error('Error al obtener mensajes');
        }

        const messagesData = await messagesResponse.json();

        if (!messagesData['hydra:member']) {
            return []; // No hay mensajes
        }

        // Si hay mensajes, obtenemos el contenido completo de cada uno
        const messages = await Promise.all(
            messagesData['hydra:member'].map(async (msg) => {
                try {
                    const messageResponse = await fetch(`https://api.mail.tm/messages/${msg.id}`, {
                        headers: {
                            'Authorization': `Bearer ${token}`
                        }
                    });

                    if (!messageResponse.ok) {
                        return msg; // Si falla, retornamos el mensaje básico
                    }

                    return messageResponse.json();
                } catch (error) {
                    console.error(`Error al obtener mensaje individual:`, error);
                    return msg;
                }
            })
        );

        return messages;
    } catch (error) {
        console.error('Error al verificar correo temporal:', error);
        throw error;
    }
};

// Función para verificar IP
export const checkIP = async (ip) => {
    try {
        console.log(`Consultando IP ${ip}...`);

        // Nueva API: ipwho.is
        const response = await fetch(`https://ipwho.is/${ip}`);
        if (!response.ok) {
            throw new Error('Error al consultar IP');
        }
        const data = await response.json();

        if (!data.success) {
            throw new Error(data.message || 'Error al consultar IP');
        }

        // Calcular nivel de riesgo
        let riskScore = 0;
        if (data.proxy) riskScore += 2;
        if (data.tor) riskScore += 3;
        if (data.hosting) riskScore += 1;

        const riskLevel = riskScore >= 3 ? 'Alto' :
            riskScore >= 1 ? 'Medio' : 'Bajo';

        return {
            ip: ip,
            country: data.country || 'Không xác định',
            city: data.city || 'Không xác định',
            isp: data.connection?.isp || 'Không xác định',
            asn: data.connection?.asn || 'Không xác định',
            organization: data.connection?.org || 'Không xác định',
            timezone: data.timezone?.id || 'Không xác định',
            proxy: data.proxy || false,
            tor: data.tor || false,
            hosting: data.hosting || false,
            riskLevel: riskLevel
        };
    } catch (error) {
        console.error('Error al consultar IP:', error);
        throw error;
    }
};

// --- Manejo de base de datos local de BINs (CSV) ---
import fs from 'fs';
import { parse } from 'csv-parse';
import path from 'path';

let binDatabase = new Map();
let isDatabaseLoaded = false;

// Función para cargar la base de datos CSV en memoria
export const loadBinDatabase = async (filePath) => {
    console.log(`Cargando base de datos de BINs desde ${filePath}...`);
    try {
        if (!fs.existsSync(filePath)) {
            console.error('Archivo de base de datos BIN no encontrado en:', filePath);
            return false;
        }

        const parser = fs.createReadStream(filePath).pipe(parse({
            columns: true,
            skip_empty_lines: true
        }));

        let count = 0;
        for await (const record of parser) {
            // Asumiendo que el campo BIN está en la primera columna o se llama "BIN"
            const bin = record.BIN || record.Bin || record.bin;
            if (bin) {
                // Guardar solo los datos necesarios para ahorrar memoria
                binDatabase.set(bin.toString(), {
                    bank: record.Issuer || record.Bank || 'Không xác định',
                    brand: record.Brand || record.Scheme || 'Không xác định',
                    type: record.Type || 'Không xác định',
                    level: record.Category || record.Level || 'Không xác định',
                    country: record.CountryName || record.Country || 'Không xác định',
                    countryCode: record.isoCode2 || record.CountryCode || '??'
                });
                count++;
            }
        }

        isDatabaseLoaded = true;
        console.log(`Base de datos de BINs cargada exitosamente: ${count} registros.`);
        return true;
    } catch (error) {
        console.error('Error al cargar la base de datos de BINs:', error);
        return false;
    }
};

// Función para buscar BIN localmente
export const lookupBinLocal = (bin) => {
    if (!isDatabaseLoaded) return null;

    // Intentar buscar coincidencias exactas y parciales (6 dígitos es el estándar, pero el CSV puede tener más)
    // Primero, buscar coincidencia exacta
    let info = binDatabase.get(bin);

    // Si no encuentra y el bin es largo, intentar cortar a 6 dígitos (o 8)
    if (!info && bin.length > 6) {
        info = binDatabase.get(bin.slice(0, 8));
        if (!info) {
            info = binDatabase.get(bin.slice(0, 6));
        }
    }

    if (info) {
        console.log(`BIN ${bin} encontrado en base de datos local.`);
        return info;
    }

    return null;
};

// Función para obtener información completa del BIN (Local + APIs)
export const getBinInfo = async (bin) => {
    try {
        // 1. Intentar búsqueda local primero
        const localInfo = lookupBinLocal(bin);
        if (localInfo) {
            console.log(`BIN ${bin} encontrado en local.`);
            return localInfo;
        }

        console.log(`BIN ${bin} no encontrado localmente. Consultando en binlist.net...`);
        // Primera API: binlist.net
        const controller1 = new AbortController();
        const timeout1 = setTimeout(() => controller1.abort(), 3000); // 3 seconds timeout

        try {
            const response1 = await fetch(`https://lookup.binlist.net/${bin}`, { signal: controller1.signal });
            clearTimeout(timeout1);
            if (response1.ok) {
                const data1 = await response1.json();
                return {
                    bank: data1.bank?.name || 'Không xác định',
                    brand: data1.scheme || 'Không xác định',
                    type: data1.type || 'Không xác định',
                    country: data1.country?.name || 'Không xác định',
                    countryCode: data1.country?.alpha2 || '??',
                    level: data1.brand || 'Không xác định'
                };
            }
        } catch (e) { clearTimeout(timeout1); }

        console.log(`Consultando BIN ${bin} en bintable.com...`);
        // Segunda API: bintable.com
        const controller2 = new AbortController();
        const timeout2 = setTimeout(() => controller2.abort(), 3000); // 3 seconds timeout

        try {
            const response2 = await fetch(`https://api.bintable.com/v1/${bin}?api_key=19d935a6d3244f3f8bab8f09157e4936`, { signal: controller2.signal });
            clearTimeout(timeout2);
            if (response2.ok) {
                const data2 = await response2.json();
                return {
                    bank: data2.bank?.name || 'Không xác định',
                    brand: data2.scheme || data2.brand || 'Không xác định',
                    type: data2.type || 'Không xác định',
                    country: data2.country?.name || 'Không xác định',
                    countryCode: data2.country?.code || '??',
                    level: data2.level || 'Không xác định'
                };
            }
        } catch (e) { clearTimeout(timeout2); }

        return {};

        return {};
    } catch (error) {
        console.error('Error al consultar BIN:', error);
        return {};
    }
};

export const generateRandomBalance = () => {
    return (Math.random() * 100).toFixed(2);
};
