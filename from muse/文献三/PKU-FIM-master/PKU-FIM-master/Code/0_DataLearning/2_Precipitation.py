# -*- coding: utf-8 -*-
# python 3.9
"""
#@Author: LW
#@FileName: 2_Precipitation.py
#@Time: 2023/5/10 16:13  
#Software: PyCharm
---------------------------
"""

import pandas as pd
import numpy as np
import os

if __name__ == '__main__':
    path = 'E:\\ABM for Human Movements'
    weatherDataPath = path + '\\Data\\2021'

    targetDate = '2021-07-20'

    stationWeatherInfo = pd.DataFrame()

    for file in os.listdir(weatherDataPath):
        station_data = pd.read_csv(weatherDataPath + '\\' + file)
        targetDateData = station_data[station_data['DATE'] == targetDate]
        if len(targetDateData) == 0:    # 当天无数据
            prcp = -1
            prcp_attr = 'J'
        else:
            prcp = targetDateData.iloc[0, -4] * 100 * 25.4
            prcp_attr = targetDateData.iloc[0, -3]
        stationName = file.split('.')[0]
        lat = station_data.iloc[0, 2]
        lng = station_data.iloc[0, 3]
        info = np.array([[stationName, targetDate, lat, lng, prcp, prcp_attr]])
        singleRecord = pd.DataFrame(info)
        stationWeatherInfo = pd.concat((stationWeatherInfo, singleRecord))
        print(file)
        # break

    cols = ['STATION', 'DATE', 'LATITUDE', 'LONGITUDE', 'PRCP', 'PRCP_ATTRIBUTES']
    stationWeatherInfo.columns = cols
    stationWeatherInfo.to_csv(path + '\\OutputData\\stationWeatherInfo210720.csv', header=True, index=False)

