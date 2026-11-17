# -*-coding:utf-8 -*-
# python 3.9
# 把2019年公开的郑州市应急避难场所进行地理编码，加到后续郑州2021年shelter POI的部分

"""
# @File       : 4_ShelterGeocode_Cali&Vali.py
# @software   : PyCharm  
# @Time       ：2025/3/26 11:42
# @Author     ：Wei Lyu
"""

import requests
import pandas as pd
import math

x_pi = 3.14159265358979324 * 3000.0 / 180.0
pi = 3.1415926535897932384626 # π
a = 6378245.0 # 长半轴
ee = 0.00669342162296594323  # 扁率

def transformlat(lng, lat):
    ret = -100.0 + 2.0 * lng + 3.0 * lat + 0.2 * lat * lat + \
          0.1 * lng * lat + 0.2 * math.sqrt(math.fabs(lng))
    ret += (20.0 * math.sin(6.0 * lng * pi) + 20.0 *
            math.sin(2.0 * lng * pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(lat * pi) + 40.0 *
            math.sin(lat / 3.0 * pi)) * 2.0 / 3.0
    ret += (160.0 * math.sin(lat / 12.0 * pi) + 320 *
            math.sin(lat * pi / 30.0)) * 2.0 / 3.0
    return ret


def transformlng(lng, lat):
    ret = 300.0 + lng + 2.0 * lat + 0.1 * lng * lng + \
          0.1 * lng * lat + 0.1 * math.sqrt(math.fabs(lng))
    ret += (20.0 * math.sin(6.0 * lng * pi) + 20.0 *
            math.sin(2.0 * lng * pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(lng * pi) + 40.0 *
            math.sin(lng / 3.0 * pi)) * 2.0 / 3.0
    ret += (150.0 * math.sin(lng / 12.0 * pi) + 300.0 *
            math.sin(lng / 30.0 * pi)) * 2.0 / 3.0
    return ret

def out_of_china(lng, lat):
    """
    判断是否在国内，不在国内不做偏移
    :param lng:
    :param lat:
    :return:
    """
    if lng < 72.004 or lng > 137.8347:
        return True
    if lat < 0.8293 or lat > 55.8271:
        return True
    return False

def gcj02towgs84(lng, lat):
    """
    GCJ02(火星坐标系)转GPS84
    :param lng:火星坐标系的经度
    :param lat:火星坐标系纬度
    :return:
    """
    if out_of_china(lng, lat):
        return lng, lat
    dlat = transformlat(lng - 105.0, lat - 35.0)
    dlng = transformlng(lng - 105.0, lat - 35.0)
    radlat = lat / 180.0 * pi
    magic = math.sin(radlat)
    magic = 1 - ee * magic * magic
    sqrtmagic = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((a * (1 - ee)) / (magic * sqrtmagic) * pi)
    dlng = (dlng * 180.0) / (a / sqrtmagic * math.cos(radlat) * pi)
    mglat = lat + dlat
    mglng = lng + dlng
    return [lng * 2 - mglng, lat * 2 - mglat]


class GaodeGeo:
    def __init__(self):
        self.key = ''
    def requestApi(self, url):
        re = requests.get(url).json()
        return re

    def getGeoCode(self, address):
        url = f'https://restapi.amap.com/v3/geocode/geo?parameters&key={self.key}&address={address}'
        json_data = self.requestApi(url)
        if json_data['status'] == '1':
            location = json_data['geocodes'][0]['location']
            return location
        else:
            return '获取失败'


if __name__ == '__main__':
    path = r'D:\LW\ABM'
    file = '2019年郑州市应急避难场所建设情况一览表 (地震局).xlsx'
    outputPath = path + r'\OutputData\zhengzhou'

    df = pd.read_excel(path + r'\Data\zhengzhou' + '\\' + file, header=0, dtype=object)

    gd = GaodeGeo()

    k = 0  # 记录调用次数

    lngs = []
    lats = []
    # 填写结构化地址信息:省份＋城市＋区县＋城镇＋乡村＋街道＋门牌号码
    for i, r in df.iterrows():
        prov = '河南省'
        city = '郑州市'
        district = '' if type(r['所在区域']) != str else r['所在区域']
        name = '' if type(r['场所名称及类别']) != str else r['场所名称及类别']
        address = '' if type(r['具体位置']) != str else r['具体位置']
        query = prov + city + district + address + name
        print(query)
        result = gd.getGeoCode(query).split(',')
        if result[0] == '获取失败':
            new_lng = -1
            new_lat = -1
        else:
            lng = float(result[0])
            lat = float(result[1])
            new_lng, new_lat = gcj02towgs84(lng, lat)
        lngs.append(new_lng)
        lats.append(new_lat)
        k += 1
        print(k, city, new_lng, new_lat)
    df['lng'] = lngs
    df['lat'] = lats
    df.to_csv(outputPath + '\\zhengzhou2019_real_shelter_part.csv', index=False, header=True)
